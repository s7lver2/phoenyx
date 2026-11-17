# Ledger fase 5 — plan: docs/superpowers/plans/2026-11-17-fase5-animacion.md
Task 1: complete (9f7daf2) skin 0.0001/max 1/0 int.
Task 2: complete (db7b006) skin-sombra 0.0001/0 int., skin-normales 0/0
Task 3: complete (escena entidades, 0.0171/max 160 en bordes, 0 int.)
Ruling: los huesos viven en la reserva de matrices de instancias (inst_mats) como tramo [bindMatrix, bindMatrixInverse, huesos...] por SkinnedMesh y no en un buffer nuevo — el limite por defecto de 8 buffers de almacenamiento por etapa ya estaba a 7 — si falla: habria que añadir un buffer y subir limites.
Ruling: tramos de huesos por malla (no por esqueleto) — bindMatrix puede diferir entre mallas que comparten esqueleto; cuesta subir huesos duplicados.
Ruling: vertice de 68 bytes para todas las geometrias (skinIndex u16x4 + skinWeight f32x4, ceros sin piel) en vez de un segundo buffer de vertices/pipelines duplicados — +55% de memoria de vertices — si falla: pipeline aparte para piel.
Ruling: tramos de huesos sin usar durante 512 render() se liberan (barrido cada 256) y la reserva reutiliza huecos libres de igual capacidad — three no avisa al quitar una malla.
Task 4: complete (d973653) entidades-pool 0.0293/0 int.; perf en docs/FASE5.md
Final: review Sonnet sin Critical/Important.
Final: minor (deferred): `bones` Map retiene la malla hasta 512-767 render() (sin listener dispose)
Final: minor (deferred): skinIndex.count != position.count: pack.ts deberia comprobar el count (caso invalido)
Final: minor (deferred): indices de hueso empaquetados en Vec<f32> con from_bits (patron NaN fragil); usar Vec<u32>/bytemuck
Final: minor (deferred): indices de hueso fuera de rango leen relleno/otro tramo (three lee ceros); GLB validos no ocurre
Final: minor (deferred): lista libre solo reutiliza capacidad exacta
