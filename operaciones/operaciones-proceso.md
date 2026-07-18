# Proceso — Agente de Operaciones

1. Consulto Neon DB para armar métricas: MRR, leads generados, tasa de conversión, churn
2. Detecto anomalías (caída brusca de MRR, pico de churn, pipeline estancado)
3. Si hay anomalía → alerto al Orquestador de inmediato, no espero al reporte semanal
4. Coordino con Finanzas & Admin el reporte ejecutivo semanal
5. Actualizo memoria.md con tendencias detectadas mes a mes
