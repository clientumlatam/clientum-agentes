// scripts/run-agentes.mjs
//
// FASE 1 — Orquestador: Jonathan abre un issue con label "agente:orquestador" y
// una instrucción en texto libre. El Orquestador la lee, decide con Gemini cuál de
// los agentes del ROSTER la debe ejecutar, y re-etiqueta el issue como
// "agente:<carpeta-elegida>". No hace falta que Jonathan sepa la taxonomía interna.
//
// FASE 2 — Loop normal: recorre los issues abiertos agrupados por label
// "agente:<carpeta>". Por cada uno: lee identidad.md -> memoria.md -> proceso.md ->
// skill.md del agente, llama a Gemini con ese contexto + el issue, postea la
// respuesta como comentario, y si el agente marca "ESTADO: DONE" cierra el issue
// y reescribe memoria.md.
//
// ENCADENAMIENTO: si la respuesta incluye "SIGUIENTE: agente:<carpeta>" y una
// descripción opcional, se abre automáticamente un nuevo issue para ese agente.
//
// NOTIFICACIONES: cuando un issue raíz completa (DONE) o un agente necesita
// intervención humana (NECESITA: humano), se envía un correo de resumen al owner.
//
// Requiere: GITHUB_TOKEN, GEMINI_API_KEY, GITHUB_REPOSITORY (owner/repo)
// Opcional: SMTP_HOST, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL (para notificaciones)
// Sin dependencias externas salvo nodemailer (instalado en el workflow) — usa fetch nativo de Node 20.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const [OWNER, REPO]   = (process.env.GITHUB_REPOSITORY || "").split("/");
const GEMINI_MODEL    = "gemini-2.0-flash";
const LABEL_PREFIX    = "agente:";
const ORQUESTADOR_LABEL = "agente:orquestador";

// ─── Notificaciones ──────────────────────────────────────────────────────────
const SMTP_HOST    = process.env.SMTP_HOST   || "smtp.gmail.com";
const SMTP_USER    = process.env.SMTP_USER;
const SMTP_PASS    = process.env.SMTP_PASS;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || SMTP_USER;

async function sendNotification(subject, body) {
  if (!SMTP_USER || !SMTP_PASS || !NOTIFY_EMAIL) {
    console.log(`[Notify] SMTP no configurado — omitiendo notificación: "${subject}"`);
    return;
  }
  try {
    // Importación dinámica — nodemailer debe estar en node_modules (instalado en el workflow)
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport({
      host: SMTP_HOST,
      port: 587,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    await transporter.sendMail({
      from: `"Orquestador Clientum" <${SMTP_USER}>`,
      to: NOTIFY_EMAIL,
      subject: `[Clientum Agentes] ${subject}`,
      text: body,
      html: `<pre style="font-family:monospace;font-size:13px;line-height:1.5">${body}</pre>`,
    });
    console.log(`[Notify] Email enviado: "${subject}"`);
  } catch (err) {
    console.warn(`[Notify] No se pudo enviar email: ${err.message}`);
  }
}

// ─── Roster de agentes ───────────────────────────────────────────────────────
const ROSTER = [
  { folder: "orquestador",                      desc: "Chief of Staff — coordina todos los departamentos, toma decisiones de alto nivel" },
  { folder: "tecnico",                           desc: "CTO AI — coordina trabajo técnico general, decide backend vs frontend vs IA/automatización" },
  { folder: "tecnico/backend-infra",             desc: "APIs, autenticación, base de datos, bugs y deploys" },
  { folder: "tecnico/frontend-ux",               desc: "CRM Kanban, dashboard, UI, componentes React" },
  { folder: "tecnico/ia-automatizacion",         desc: "Brochures, MEDDIC scoring, enriquecimiento de contactos" },
  { folder: "ventas",                            desc: "Sales Manager AI — coordina prospección, outreach, calificación, cierre" },
  { folder: "ventas/santi-sdr",                  desc: "SDR outbound — contacta leads por WhatsApp y los clasifica" },
  { folder: "ventas/explorador-patagonico",      desc: "Lead generation — prospección en Google Maps/Apify" },
  { folder: "marketing",                         desc: "Marketing Manager AI — coordina contenido, SEO, campañas" },
  { folder: "marketing/seo-contenido",           desc: "Blog posts, landing pages, keywords" },
  { folder: "customer-success",                  desc: "CS Manager AI — salud de clientes, onboarding, churn" },
  { folder: "customer-success/asesor-comercial-ia", desc: "Chatbot inbound del sitio web" },
  { folder: "operaciones",                       desc: "COO AI — reportes, métricas, alertas de anomalías" },
  { folder: "operaciones/finanzas-admin",        desc: "Reportes semanales, MRR, facturación, pipeline revenue" },
];

if (!GITHUB_TOKEN || !GEMINI_API_KEY || !OWNER || !REPO) {
  console.error("Faltan variables de entorno (GITHUB_TOKEN / GEMINI_API_KEY / GITHUB_REPOSITORY).");
  process.exit(1);
}

const ghHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

// ─── GitHub helpers ───────────────────────────────────────────────────────────
async function gh(pathname, opts = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...opts,
    headers: { ...ghHeaders, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`GitHub API ${pathname} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function listOpenIssues() {
  return gh(`/repos/${OWNER}/${REPO}/issues?state=open&per_page=100`);
}

async function listComments(issueNumber) {
  return gh(`/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments?per_page=50`);
}

async function postComment(issueNumber, body) {
  return gh(`/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function closeIssue(issueNumber) {
  return gh(`/repos/${OWNER}/${REPO}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
}

async function setLabels(issueNumber, labels) {
  return gh(`/repos/${OWNER}/${REPO}/issues/${issueNumber}/labels`, {
    method: "PUT",
    body: JSON.stringify({ labels }),
  });
}

/** Abre un issue nuevo para encadenar al siguiente agente */
async function openChainIssue(targetFolder, title, body, originIssueNumber) {
  const label = `${LABEL_PREFIX}${targetFolder}`;
  const fullBody = `${body}\n\n---\n_Encadenado automáticamente desde issue #${originIssueNumber}_`;
  const issue = await gh(`/repos/${OWNER}/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body: fullBody, labels: [label] }),
  });
  console.log(`   ⛓️  Encadenado → issue #${issue.number} para agente: ${targetFolder}`);
  return issue;
}

// ─── Agent files ──────────────────────────────────────────────────────────────
function agentFolderFromLabels(labels) {
  const label = labels.map((l) => (typeof l === "string" ? l : l.name)).find((n) => n?.startsWith(LABEL_PREFIX));
  if (!label) return null;
  return label.slice(LABEL_PREFIX.length).trim();
}

async function readAgentFiles(folder) {
  const base = path.join(process.cwd(), folder);
  const files = ["identidad.md", "memoria.md", "proceso.md", "skill.md"];
  const out = {};
  for (const f of files) {
    const p = path.join(base, f);
    out[f] = existsSync(p) ? await readFile(p, "utf8") : `(no existe ${f})`;
  }
  return out;
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function callGemini(systemContext, issue, comments) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const historial = comments.map((c) => `--- comentario previo (${c.user?.login}) ---\n${c.body}`).join("\n\n");

  const prompt = `
Sos un agente autónomo de Clientum. Actuá SIEMPRE según tu identidad, memoria y proceso.
No inventes herramientas que no tengas en tu skill.md.

# IDENTIDAD
${systemContext["identidad.md"]}

# MEMORIA (contexto acumulado)
${systemContext["memoria.md"]}

# PROCESO
${systemContext["proceso.md"]}

# SKILL (herramientas disponibles)
${systemContext["skill.md"]}

# TAREA (issue de GitHub)
Título: ${issue.title}
Descripción: ${issue.body || "(sin descripción)"}

${historial}

# INSTRUCCIONES DE RESPUESTA
1. Ejecutá el siguiente paso concreto de la tarea según tu proceso.md.
2. Si con este paso la tarea queda completa, terminá tu respuesta con la línea exacta:
   ESTADO: DONE
3. Si falta trabajo para una próxima corrida, terminá con:
   ESTADO: EN_PROGRESO
4. Si necesita intervención humana (decisión de negocio, credencial faltante, etc.):
   NECESITA: humano
   MOTIVO: <una línea describiendo qué necesitás de Jonathan>
5. Si al completar esta tarea corresponde que OTRO agente ejecute una tarea de continuación,
   agregá ANTES del estado final:
   SIGUIENTE: agente:<carpeta-del-roster>
   TITULO: <título del issue a crear para ese agente>
   DESCRIPCION: <breve descripción de la tarea que debe ejecutar ese agente>
6. Sé breve y concreto. Esto se postea como comentario en el issue.
`.trim();

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini API -> ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(sin respuesta del modelo)";
}

async function routearConGemini(issue) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const listaRoster = ROSTER.map((r) => `- ${r.folder} → ${r.desc}`).join("\n");

  const prompt = `
Sos el Orquestador de Clientum. Tu único trabajo es leer una instrucción de Jonathan
(el dueño de la empresa) y decidir cuál de estos agentes la debe ejecutar.
NUNCA ejecutás la tarea vos mismo, solo la ruteás.
Si la tarea involucra múltiples departamentos, ruteá al coordinador más adecuado.

# ROSTER DE AGENTES DISPONIBLES (elegí EXACTAMENTE uno de estos "folder")
${listaRoster}

# INSTRUCCIÓN DE JONATHAN
Título: ${issue.title}
Descripción: ${issue.body || "(sin descripción)"}

# RESPUESTA
Respondé con SOLO dos líneas, sin nada más:
AGENTE: <folder exacto del roster>
RAZON: <una frase corta de por qué>
`.trim();

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini API (routeo) -> ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  const folderMatch = texto.match(/AGENTE:\s*(\S+)/i);
  const razonMatch  = texto.match(/RAZON:\s*(.+)/i);
  const folder = folderMatch?.[1]?.trim();
  const razon  = razonMatch?.[1]?.trim() || "(sin razón provista)";

  const valido = ROSTER.some((r) => r.folder === folder);
  if (!valido) throw new Error(`Gemini devolvió un agente fuera del roster: "${folder}"`);

  return { folder, razon };
}

// ─── Memoria ──────────────────────────────────────────────────────────────────
async function updateMemoria(folder, issue, respuesta, estado) {
  const memoriaPath = path.join(process.cwd(), folder, "memoria.md");
  const fecha = new Date().toISOString().slice(0, 16).replace("T", " ");
  const entrada = `\n- **${fecha}** — Issue #${issue.number} "${issue.title}" — estado: ${estado}\n  ${respuesta.slice(0, 400).replace(/\n/g, " ")}\n`;

  let actual = existsSync(memoriaPath) ? await readFile(memoriaPath, "utf8") : "# Memoria\n";
  if (actual.includes("(vacío — primera ejecución pendiente)")) {
    actual = actual.replace("(vacío — primera ejecución pendiente)", "").trimEnd() + "\n";
  }
  await writeFile(memoriaPath, actual + entrada, "utf8");
}

// ─── Parsear directivas de encadenamiento ─────────────────────────────────────
function parsearEncadenamiento(respuesta) {
  // SIGUIENTE: agente:<folder>
  // TITULO: <título>
  // DESCRIPCION: <descripción>
  const siguienteMatch = respuesta.match(/SIGUIENTE:\s*agente:(\S+)/i);
  if (!siguienteMatch) return null;

  const folder = siguienteMatch[1].trim();
  const tituloMatch = respuesta.match(/TITULO:\s*(.+)/i);
  const descMatch   = respuesta.match(/DESCRIPCION:\s*(.+)/i);

  const valido = ROSTER.some((r) => r.folder === folder);
  if (!valido) {
    console.warn(`   ⚠️  SIGUIENTE apunta a un agente fuera del roster: "${folder}" — ignorado.`);
    return null;
  }

  return {
    folder,
    titulo: tituloMatch?.[1]?.trim() || `Tarea encadenada desde issue`,
    descripcion: descMatch?.[1]?.trim() || "(ver issue de origen)",
  };
}

// ─── Parsear necesita humano ──────────────────────────────────────────────────
function parsearNecesitaHumano(respuesta) {
  if (!/NECESITA:\s*humano/i.test(respuesta)) return null;
  const motivoMatch = respuesta.match(/MOTIVO:\s*(.+)/i);
  return motivoMatch?.[1]?.trim() || "El agente requiere intervención humana.";
}

// ─── Fase 1: Orquestador ─────────────────────────────────────────────────────
async function runOrquestador() {
  const issues = await listOpenIssues();
  const paraRutear = issues.filter(
    (i) => !i.pull_request && i.labels.some((l) => (typeof l === "string" ? l : l.name) === ORQUESTADOR_LABEL)
  );

  if (paraRutear.length === 0) {
    console.log("Orquestador: no hay instrucciones nuevas de Jonathan para rutear.");
    return;
  }

  for (const issue of paraRutear) {
    console.log(`Orquestador -> rutear issue #${issue.number} "${issue.title}"`);
    try {
      const { folder, razon } = await routearConGemini(issue);

      const labelsActuales = issue.labels
        .map((l) => (typeof l === "string" ? l : l.name))
        .filter((n) => n !== ORQUESTADOR_LABEL);

      await setLabels(issue.number, [...labelsActuales, `${LABEL_PREFIX}${folder}`]);
      await postComment(
        issue.number,
        `**Orquestador** asignó este issue a \`${folder}\`.\nMotivo: ${razon}\n\nSe procesa en la próxima corrida del cron (máx. 15 min).`
      );
      await updateMemoria("orquestador", issue, `Ruteado a ${folder}. ${razon}`, "RUTEADO");
      console.log(`   Ruteado a ${folder}.`);
    } catch (err) {
      console.error(`   Error ruteando issue #${issue.number}:`, err.message);
      await postComment(
        issue.number,
        `**Orquestador**: no pude clasificar este issue automáticamente (${err.message}). Necesito que le pongas manualmente el label \`agente:<carpeta>\` correcto.`
      ).catch(() => {});
    }
  }
}

// ─── Fase 2: Loop de agentes ─────────────────────────────────────────────────
async function main() {
  // Fase 1: rutear instrucciones nuevas de Jonathan
  await runOrquestador();

  // Fase 2: ejecutar issues asignados a cada agente
  const issues = await listOpenIssues();
  const conAgente = issues.filter((i) => !i.pull_request && agentFolderFromLabels(i.labels));

  if (conAgente.length === 0) {
    console.log("No hay issues abiertos con label 'agente:*'. Nada que hacer en esta corrida.");
    return;
  }

  const resumen = []; // para el email de notificación al final

  for (const issue of conAgente) {
    const folder = agentFolderFromLabels(issue.labels);
    console.log(`-> Issue #${issue.number} "${issue.title}" — agente: ${folder}`);

    try {
      const agentFiles = await readAgentFiles(folder);
      const comments   = await listComments(issue.number);
      const respuesta  = await callGemini(agentFiles, issue, comments);

      await postComment(issue.number, respuesta);

      // ── Detectar estado ──────────────────────────────────────────────────
      const isDone          = respuesta.includes("ESTADO: DONE");
      const necesitoHumano  = parsearNecesitaHumano(respuesta);
      const estado          = isDone ? "DONE" : necesitoHumano ? "NECESITA_HUMANO" : "EN_PROGRESO";

      await updateMemoria(folder, issue, respuesta, estado);

      if (isDone) {
        await closeIssue(issue.number);
        console.log(`   Issue #${issue.number} cerrado (DONE).`);
        resumen.push({ issue, folder, estado: "DONE" });

        // ── Encadenamiento ─────────────────────────────────────────────────
        const siguiente = parsearEncadenamiento(respuesta);
        if (siguiente) {
          const chainIssue = await openChainIssue(
            siguiente.folder,
            siguiente.titulo,
            siguiente.descripcion,
            issue.number
          );
          resumen.push({ issue: chainIssue, folder: siguiente.folder, estado: "ENCADENADO" });
        }

      } else if (necesitoHumano) {
        console.log(`   Issue #${issue.number} NECESITA intervención humana: ${necesitoHumano}`);
        resumen.push({ issue, folder, estado: "NECESITA_HUMANO", motivo: necesitoHumano });
        // Notificación inmediata
        await sendNotification(
          `⚠️ Agente ${folder} necesita tu atención — Issue #${issue.number}`,
          `Agente: ${folder}\nIssue #${issue.number}: ${issue.title}\n\nMotivo:\n${necesitoHumano}\n\nLink: https://github.com/${OWNER}/${REPO}/issues/${issue.number}`
        );
      } else {
        console.log(`   Issue #${issue.number} sigue abierto (EN_PROGRESO).`);
      }

    } catch (err) {
      console.error(`   Error procesando issue #${issue.number}:`, err.message);
      resumen.push({ issue, folder, estado: "ERROR", motivo: err.message });
    }
  }

  // ── Notificación de resumen si hubo DONEs ──────────────────────────────────
  const dones = resumen.filter((r) => r.estado === "DONE" || r.estado === "ENCADENADO");
  if (dones.length > 0) {
    const lineas = resumen.map((r) => {
      const link = `https://github.com/${OWNER}/${REPO}/issues/${r.issue.number}`;
      if (r.estado === "DONE")           return `✅ DONE        — Issue #${r.issue.number} (${r.folder}): ${r.issue.title}\n   ${link}`;
      if (r.estado === "ENCADENADO")     return `⛓️  ENCADENADO  — Issue #${r.issue.number} (${r.folder}): ${r.issue.title}\n   ${link}`;
      if (r.estado === "NECESITA_HUMANO") return `⚠️  HUMANO      — Issue #${r.issue.number} (${r.folder}): ${r.motivo}`;
      if (r.estado === "ERROR")          return `❌ ERROR       — Issue #${r.issue.number} (${r.folder}): ${r.motivo}`;
      return `🔄 EN_PROGRESO — Issue #${r.issue.number} (${r.folder})`;
    }).join("\n");

    await sendNotification(
      `Resumen de corrida — ${dones.length} tarea(s) completada(s)`,
      `Corrida: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\nRepo: ${OWNER}/${REPO}\n\n${lineas}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
