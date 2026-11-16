# phoenix-ai

Base de IA (`crates/phoenix-ai`). Solo aporta primitivas; **los algoritmos de comportamiento (estados, prioridades, qué hace cada entidad) viven en el proyecto del juego**, en su propio código, y llaman a esta base.

```
cargo build --release --target wasm32-unknown-unknown -p phoenix-ai
wasm-bindgen --target web --out-dir web/pkg-ai target/wasm32-unknown-unknown/release/phoenix_ai.wasm
```

## Qué ofrece

| Pieza | Para qué |
|---|---|
| `Rng(seed)` | PCG32 determinista (`next`, `range`, `below`, `u32`). Sustituye a `Math.random` para que servidor y cliente coincidan. |
| `Grid(w, h, cell)` | Rejilla de celdas libres u ocupadas (4 vecinos). `set_solid`, `load`, `is_solid`, `cell_x/cell_y`. |
| `Grid.flood(x, y, limit)` + `dist_at` | Mapa de distancias (BFS) desde una celda; sirve para perseguir (`descend`) y huir (`flee`) sin trazar rutas por entidad. |
| `Grid.astar(ax, ay, bx, by, smooth)` + `path()` | Ruta entre celdas, en metros `[x, z, …]`; con `smooth` quita puntos con línea de visión. |
| `Grid.sees(ax, az, bx, bz)` | Línea de visión sobre la rejilla. |
| `in_cone(...)`, `hears(...)` | Percepción: cono de visión/linterna y oído por radio. |
| `Clock(hz, max_ticks)` | Paso fijo: `advance(dt)` devuelve los ticks a simular; `alpha()` para interpolar el dibujo. |
| `Store(capacidad, columnas)` | Entidades en columnas f32 con ids con generación (`spawn`, `despawn`, `valid`, `get`, `set`, `row`, `alive_ids`). |
| `Near(ancho, alto, celda)` | Hash espacial: `rebuild(posiciones)` una vez por tick y `query(x, z, r)` para «quién está cerca». |

Los buffers se reutilizan entre llamadas; `path()` y `query()` copian el resultado.

## Reparto de responsabilidades

- **Base (aquí):** datos y consultas caras o que deben ser deterministas.
- **Juego:** cada comportamiento (`wander`, `chase`, `inspect`…), su orden de prioridad, constantes de percepción, reglas de aparición. En Backrooms hoy está en `shared/src/sim.ts` y `parking-*-ai.ts`; la migración consiste en cambiar `bfs`, `Math.random` y `seesXZ` por llamadas a `phoenix-ai`, sin mover los comportamientos.

## Pendiente

- `Store` es un almacén de columnas, no un ECS con sistemas: el juego recorre `alive_ids()` y aplica sus comportamientos.
- Solo rejillas 2D de 4 vecinos; sin mallas de navegación 3D ni costes por celda.
- Sin integración con el juego: no se ha sustituido nada en `shared/src` todavía.
