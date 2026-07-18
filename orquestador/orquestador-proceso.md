# Proceso — Orquestador IA

**Esto ya está implementado en `scripts/run-agentes.mjs` (función `runOrquestador`), no es solo teoría:**

1. Jonathan abre un Issue en GitHub con label `agente:orquestador` y su instrucción
   en texto libre (título + descripción) — no necesita saber la taxonomía interna
2. El cron toma ese issue, le paso el ROSTER cerrado de agentes a Gemini y decido
   cuál lo debe ejecutar
3. Re-etiqueto el issue: saco `agente:orquestador`, pongo `agente:<carpeta-elegida>`
4. Comento en el issue explicando a quién lo asigné y por qué
5. El issue queda listo para que ese agente lo procese en la corrida siguiente (máx. 15 min)
6. Actualizo memoria.md con el historial de ruteos

**Pendiente (no implementado aún):** coordinar flujos que cruzan varios agentes a
la vez (ej: un lead cerrado por Ventas debería disparar trabajo en Técnico
automáticamente). Hoy cada issue se rutea a UN solo agente. Y todavía no hay
notificación proactiva a Jonathan cuando algo termina — hay que revisar el issue
o el resumen del tablero manualmente.
