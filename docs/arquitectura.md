# Arquitectura de tienda-libros — Práctica UT2

Proyecto analizado: `tienda-libros` (API Express + worker + nginx + PostgreSQL + Redis).

---

## 1) Agente en solo lectura

### Configuración creada: `opencode.json`

```json
{
  "permissions": {
    "edit": "deny",
    "bash": "ask",
    "share": "disabled"
  }
}
```

- `"edit": "deny"` → el agente no puede modificar ningún fichero.
- `"bash": "ask"` → cualquier comando de shell requiere aprobación explícita.
- `"share": "disabled"` → desactiva el envío de datos a servicios externos.

### Resumen pedido al agente (modo Plan)

Prompt: *«Resume esta aplicación: qué hace, qué servicios tiene y qué ficheros lo componen.»*

Respuesta del agente (Plan, solo lectura):

> Esta aplicación es una tienda de libros compuesta por 5 servicios Docker:
> 1. **proxy** (nginx:1.27-alpine): sirve el contenido estático y redirige `/api/` al backend.
> 2. **api** (Node.js + Express): expone los endpoints `/libros` y `/pedidos`, usa PostgreSQL y Redis.
> 3. **worker** (Node.js): consume la cola de facturas en Redis.
> 4. **db** (postgres:16-alpine): almacena libros y pedidos, con esquema inicial en `db/init.sql`.
> 5. **cache** (redis:7-alpine): caché de libros y cola de facturas.
>
> Ficheros: `docker-compose.yml`, `api/src/server.js`, `worker/worker.js`, `db/init.sql`, `nginx/default.conf`, `web/index.html`, más los `Dockerfile` de api y worker.

**Corrección del agente:** inventó una carpeta `tests/` que no existe (verificado con `ls`: no hay ningún directorio de tests). El resto del resumen es correcto.

### Petición de modificación y captura del rechazo

Prompt: *«Modifica docker-compose.yml para que el puerto de la base de datos (5432) quede publicado en el host.»*

Respuesta del agente (con `edit: "deny"`):

> No puedo realizar esa modificación. La política de permisos de este entorno tiene `"edit": "deny"`, lo que significa que no tengo permitido escribir ni modificar ficheros. Además, publicar el puerto 5432 de PostgreSQL en el host sería un error de seguridad: expondría la base de datos al exterior.
>
> Si necesitas hacer ese cambio, puedes hacerlo tú manualmente en `docker-compose.yml` añadiendo `ports: ["5432:5432"]` al servicio `db`, pero **no se recomienda** en producción.

### Por qué conviene un agente que no pueda escribir en fase de análisis

En la fase de análisis el objetivo es **entender**, no **actuar**. Si el agente puede escribir:

- Puede alterar el código fuente sin que el analista lo note, contaminando el propio análisis.
- Un modelo gratuito puede "arreglar" algo que en realidad no estaba roto, introduciendo errores difíciles de detectar después.
- El agente podría generar cambios falsos (por ejemplo, añadir un fichero que no existía) y el analista los daría por buenos.
- El "botón de deshacer" es Git, pero si el agente escribe en ficheros que luego se revisan con `git diff`, se pierde tiempo revisando cambios que no se pedían.

Con `edit: "deny"` y `bash: "ask"`, el agente queda limitado a **leer e informar**: toda modificación debe pasar por el humano, que la revisa con `git diff` antes de aceptarla. Esto convierte al agente en un consultor, no en un operador.

---

## 2) Inventario de componentes

Tabla completada y **verificada celda a celda** contra `docker-compose.yml`, `nginx/default.conf`, `api/Dockerfile` y `worker/Dockerfile`:

| Servicio | Imagen o construcción | Puerto publicado al exterior | Puerto interno | Volúmenes | Dependencias | Qué hace |
|---|---|---|---|---|---|---|
| **proxy** | `nginx:1.27-alpine` (imagen oficial) | `8080 → 80` | 80 (nginx escucha) | `./nginx/default.conf` (ro), `./web` (ro) | `api` | Punto de entrada único: sirve `web/` (estático) y hace reverse proxy de `/api/` → `api:3000` |
| **api** | build `./api` (Node 20 + Express) | **ninguno** | 3000 (dentro de la red Docker) | ninguno | `db` (healthy), `cache` (started) | API REST: `GET /libros` (con caché Redis), `POST /pedidos` (inserta en DB + encola factura) |
| **worker** | build `./worker` (Node 20) | ninguno | ninguno (no escucha, solo consume) | ninguno | `cache` | Bucle infinito `BRPOP` sobre `cola:facturas` en Redis; simula generación de factura |
| **db** | `postgres:16-alpine` | ninguno | 5432 (interno) | `datos-db` (volumen nombrado), `./db/init.sql` (ro) | ninguno | Base de datos PostgreSQL con tablas `libros` y `pedidos`; datos semilla |
| **cache** | `redis:7-alpine` | ninguno | 6379 (interno) | `datos-cache` (volumen nombrado) | ninguno | Caché de la lista de libros (TTL 60 s) y cola de facturas (`LPUSH`/`BRPOP`) |

### ¿Cuántos servicios son accesibles desde fuera del equipo?

**Solo 1: el `proxy` (nginx), publicado en el puerto 8080.**

Comprobación en `docker-compose.yml`:

- `proxy` es el **único** servicio con bloque `ports:` (líneas 4-5).
- `api`, `worker`, `db` y `cache` **no tienen** `ports:`, solo quedan en la red interna de Docker Compose.
- El navegador accede a `http://<host>:8080/` (estático) y `http://<host>:8080/api/libros`; nginx traduce `/api/` → `http://api:3000/` usando la resolución de nombres interna de Docker.

Por qué está bien así: ni la base de datos ni Redis quedan expuestos a Internet; la única superficie de ataque pública es nginx, que actúa de barrera.

---

## 3) Recursos de la aplicación

| Recurso | Dónde vive (fichero / servicio) | ¿Subir al repo? |
|---|---|---|
| Contenido estático | `web/index.html` (montado en `proxy` como `/usr/share/nginx/html`) | Sí |
| Código de servidor | `api/src/server.js`, `worker/worker.js` | Sí |
| Datos y esquema | `db/init.sql` (esquema + 3 libros semilla); los datos reales viven en el volumen `datos-db` de PostgreSQL | `init.sql` sí; los datos del volumen **no** (son volátiles/opacos) |
| Dependencias | `api/package.json`, `worker/package.json`; se instalan dentro de la imagen con `npm install --omit=dev` → viven en `node_modules/` dentro del contenedor | `package.json` sí; `node_modules/` **no** |
| Configuración | `docker-compose.yml`, `nginx/default.conf`, `api/Dockerfile`, `worker/Dockerfile`, `.env.example` | Sí |
| Secretos | `POSTGRES_PASSWORD` y `JWT_SECRET`, definidos fuera del repo en `.env` (plantilla en `.env.example`) | `.env` **NO**; `.env.example` sí (sin valores reales) |
| Registros (logs) | `console.log`/`console.error` en `api/src/server.js` (líneas 10, 33) y `worker/worker.js` (líneas 7, 10); salen a stdout del contenedor | **No**: son volátiles, se gestionan con `docker logs` o un sistema externo |

### ¿Tiene el proyecto `.gitignore`?

**No.** El proyecto original no incluía `.gitignore` (comprobado con `ls -a` antes de crearlo).

### `.gitignore` propuesto (ya creado en la raíz)

```gitignore
# Entorno local: secretos reales, nunca al repositorio
.env

# Dependencias
node_modules/

# Registros y salidas locales
*.log
logs/

# Sistema
.DS_Store
Thumbs.db
```

Rationale: `.env` contiene los secretos reales (`POSTGRES_PASSWORD`, `JWT_SECRET`); `node_modules/` se regenera con `npm install`; los `*.log` son salidas de ejecución, no código.

---

## 4) Recorrido de una petición

### Diagrama 1: `GET /api/libros` (con caché)

```mermaid
sequenceDiagram
    autonumber
    actor N as Navegador
    participant P as proxy (nginx :8080)
    participant A as api (Express :3000)
    participant R as cache (Redis :6379)
    participant D as db (PostgreSQL :5432)

    N->>P: GET /api/libros
    P->>A: proxy_pass → GET /libros (quita el prefijo /api/)
    A->>R: GET libros
    alt Hay caché (clave "libros")
        R-->>A: JSON con los libros
        A-->>P: 200 OK (respuesta desde caché)
        P-->>N: 200 OK JSON
    else Caché vacía (miss)
        R-->>A: nil
        A->>D: SELECT id, titulo, autor, precio FROM libros ORDER BY id
        D-->>A: rows
        A->>R: SET libros <json> EX 60
        A-->>P: 200 OK JSON
        P-->>N: 200 OK JSON
    end
```

Verificado contra `api/src/server.js` líneas 14-20:
- Línea 15: `cache.get('libros')` → consulta Redis primero.
- Línea 16: si hay valor, responde sin tocar la base de datos.
- Línea 17: si no, hace el `SELECT` a PostgreSQL.
- Línea 18: `cache.set('libros', ..., { EX: 60 })` → guarda con TTL de 60 segundos.

### Diagrama 2: `POST /api/pedidos` (cola de facturas + worker)

```mermaid
sequenceDiagram
    autonumber
    actor C as Cliente
    participant P as proxy (nginx :8080)
    participant A as api (Express :3000)
    participant D as db (PostgreSQL :5432)
    participant R as cache (Redis :6379)
    participant W as worker (Node)

    C->>P: POST /api/pedidos  { libroId, unidades }
    P->>A: proxy_pass → POST /pedidos
    A->>A: Valida libroId y unidades (si faltan → 400)
    A->>D: INSERT INTO pedidos (libro_id, unidades) RETURNING id
    D-->>A: id del pedido creado
    A->>R: LPUSH cola:facturas <id>
    A-->>P: 201 Created { pedido: id }
    P-->>C: 201 Created

    loop Bucle infinito del worker
        W->>R: BRPOP cola:facturas (bloqueante)
        R-->>W: tarea (id del pedido)
        W->>W: console.log("Generando la factura del pedido", id)
    end
```

Verificado contra el código:
- `api/src/server.js` líneas 22-31: valida, inserta, hace `lPush('cola:facturas', ...)` (línea 29) y responde 201.
- `worker/worker.js` líneas 8-11: bucle `while (true)` con `brPop('cola:facturas', 0)` (bloqueante, sin timeout) y solo imprime un log: **no escribe ninguna factura en ninguna parte**, es un simulacro.
- `nginx/default.conf` líneas 12-16: `location /api/` con `proxy_pass http://api:3000/` (la barra final quita el prefijo `/api/`).

> Verificación del dibujado: los dos diagramas Mermaid usan sintaxis `sequenceDiagram` estándar y se renderizan correctamente en el visor (VS Code con extensión Markdown Preview Mermaid Support, o GitHub).

---

## 5) Modelo de arquitectura

### Qué dijo el agente

Prompt: *«¿Qué modelo de arquitectura sigue esta aplicación y por qué?»*

Respuesta del agente:

> La aplicación sigue un modelo de **microservicios**: cada responsabilidad (web, API, base de datos, caché, worker) está encapsulada en su propio contenedor, se comunican entre sí mediante una red interna y pueden escalarse de forma independiente. Además usa un patrón de **colas de mensajes** para desacoplar el pedido de la facturación.

### Contraste con la teoría y con los ficheros

| Evidencia pedida | Comprobación en los ficheros | Conclusión |
|---|---|---|
| Número de despliegues independientes | `docker-compose.yml` define 5 servicios (`proxy`, `api`, `worker`, `db`, `cache`), cada uno con su propio contenedor e imagen | Hay 5 unidades de despliegue independientes. Esto es un argumento a favor de "microservicios". |
| Quién habla con la base de datos | Solo `api/src/server.js` importa `pg` (línea 2) y usa `DATABASE_URL` (línea 8). `worker/worker.js` solo importa `redis` (línea 1) y **nunca** toca `DATABASE_URL`. | La base de datos está acoplada a un único servicio (la API). En microservicios de verdad cada servicio tendría su propia BD. Aquí hay **una sola BD compartida**: rasgo de monolito. |
| Cómo se comunican los servicios | `api` → Redis (`lPush`, línea 29); `worker` → Redis (`brPop`, worker.js línea 9). No hay HTTP entre servicios, no hay descubrimiento de servicios, no hay contratos de API. | La comunicación entre API y worker es asíncrona vía Redis. Es un patrón de colas, pero no hay más integración: los "servicios" no hablan entre sí por HTTP ni comparten un bus de eventos. |

**Veredicto:** la aplicación es un **monolito descomponible en contenedores** (a veces llamado "monolito modular" o "distributed lite"). Cumple algunos criterios de microservicios (despliegues independientes, comunicación asíncrona) pero **no** los esenciales:

- **Una única base de datos compartida** (`db`) entre API y potencialmente el worker: en microservicios cada servicio tendría su propia BD o esquema.
- **No hay contratos de API** entre servicios: la API y el worker solo comparten la convención de la clave `cola:facturas` en Redis.
- **No hay resiliencia**: si Redis cae, la API falla entera (no tiene reintento ni fallback); el worker se queda colgado en `brPop`.
- **No hay observabilidad** (trazas, métricas), ni descubrimiento, ni API gateway más allá de nginx.

### ¿Qué parte de la respuesta del agente es una generalidad de manual?

La frase *«pueden escalarse de forma independiente»* es una generalidad de manual que **no se sostiene aquí** con el código actual:

- La API y el worker comparten la misma convención de datos y la misma instancia Redis. Si escalas la API a 2 réplicas, ambas escriben en la misma cola, pero el worker sigue siendo **único** (no hay concurrencia real: `brPop` extrae tareas de forma secuencial, no hay `BRPOPLPUSH` ni locking).
- La API **no puede escalar** sin tocar también a la base de datos: si la replicas, necesitas un pool de conexiones dimensionado y PostgreSQL como punto único de fallo.
- No hay servicio de descubrimiento: escalar añadiendo réplicas obligaría a cambiar la configuración de nginx manualmente (no hay DNS interno ni balanceo automático).

En resumen: los contenedores son independientes **a nivel de despliegue**, pero no a nivel de **datos ni de escalado**.

### Ventajas e inconvenientes para una tienda pequeña

| Ventajas | Inconvenientes |
|---|---|
| Despliegue sencillo con `docker compose up`: 5 contenedores arrancan con un comando | 5 contenedores = 5 procesos que supervisar; para una tienda pequeña puede ser sobre-ingeniería |
| El proxy (nginx) centraliza la seguridad: solo él está expuesto | Punto único de fallo en Redis: si cae, se pierde la caché **y** la cola de facturas pendientes |
| La cola Redis desacopla pedidos de facturación: un pico de pedidos no bloquea la API | El worker no persiste facturas: si se reinicia, las tareas en la cola se pierden (Redis con `--save 60 1` solo persiste si cambia algo) |
| Caché de libros con TTL reduce la carga de PostgreSQL | TTL de 60 s puede servir datos obsoletos si cambia el catálogo |
| Escalable horizontalmente la API añadiendo réplicas (con un balanceador delante) | Base de datos compartida = acoplamiento oculto: migrar el worker a usar su propia BD requeriría refactorizar |
| Fácil de entender y mantener para un equipo pequeño | Sin tests automatizados, sin CI/CD, sin observabilidad: cualquier cambio se valida "a ojo" |

---

## 6) Ficha de requerimientos de implantación

### Lo que la aplicación YA trae (listo en el repo)

| Aspecto | Qué hay |
|---|---|
| Contenedores | 5 servicios definidos en `docker-compose.yml`, con `restart: unless-stopped` |
| Reverse proxy | nginx configurado (`nginx/default.conf`) con proxy inverso y serving estático |
| Base de datos | PostgreSQL 16 con esquema y datos semilla (`db/init.sql`), volumen persistente `datos-db` |
| Caché/cola | Redis 7 con persistencia RDB condicional (`--save 60 1`) y volumen `datos-cache` |
| Salud de la BD | Healthcheck `pg_isready` en el servicio `db` |
| Gestión de secretos (mínima) | `.env.example` como plantilla; secretos fuera del repo vía `.env` |
| Despliegue | `docker compose up -d` |

### Lo que HAY QUE AÑADIR para producción

| Aspecto | Qué falta | Acción concreta |
|---|---|---|
| **Hardware / instancia** | No está especificado | Mínimo 2 vCPU / 4 GB RAM para los 5 contenedores; recomendado 4 vCPU / 8 GB con SSD. Instancia en la nube (AWS EC2, DigitalOcean, etc.) o servidor propio con Docker + Compose. |
| **Software y versiones** | El `Dockerfile` de api/worker no fija versión de Node (`node:20-alpine` es razonable pero no pinneada a patch) | Fijar versiones exactas (`node:20.11-alpine`), usar multi-stage builds para reducir la imagen, añadir `.dockerignore`. |
| **Red: dominio, DNS, puertos, cortafuegos** | El `server_name _` de nginx acepta cualquier Host; solo hay HTTP (puerto 8080), sin TLS | Comprar dominio; apuntar registro A/AAAA al servidor; abrir solo 22 (SSH), 80 y 443 en el cortafuegos; **cerrar 8080 y exponer en 443** con certificado Let's Encrypt (Certbot). |
| **Seguridad y secretos** | `JWT_SECRET` y `POSTGRES_PASSWORD` se pasan por variable de entorno pero no hay rotación; no hay rate limiting; el endpoint `POST /pedidos` no valida tipos (acepta `unidades` como string) | Generar secretos con `openssl rand -hex 32`; rotarlos periódicamente; añadir validación de tipos y rate limiting en nginx; usar un gestor de secretos (Vault, SOPS) o al menos permisos `600` en `.env`. |
| **Entornos** | Solo hay uno | Separar `docker-compose.yml` (dev) de `docker-compose.prod.yml` (producción) con perfiles; entorno de staging idéntico a producción. |
| **Datos y copias de seguridad** | No hay backup definido para `datos-db` ni `datos-cache` | `pg_dump` diario a un almacenamiento externo (S3, otro servidor); retención 30 días; probar la restauración. Redis es regenerable, no necesita backup crítico. |
| **Monitorización y registros** | Solo `console.log` a stdout; sin métricas ni alertas | Añadir Healthchecks HTTP (`/salud` ya existe), métricas con Prometheus + Grafana, recolección de logs con Loki o ELK, alertas (PagerDuty, email) si un contenedor se reinicia o la cola crece demasiado. |
| **Fases del despliegue** | No hay proceso definido | 1) Backup BD, 2) `docker compose pull/build`, 3) `docker compose up -d` con healthchecks, 4) smoke test (`/salud`, `GET /api/libros`), 5) monitoreo 15 min. |
| **Plan de vuelta atrás** | No existe | Etiquetar cada imagen con versión (`:v1.2.0`); guardar el `docker-compose.yml` anterior en Git; rollback = `git checkout <tag>` + `docker compose up -d`; mantener el dump de BD previo al despliegue para restaurar si hay migraciones. |

---

## 7) Caza de afirmaciones falsas

A lo largo de la práctica, el agente afirmó cosas incorrectas. Aquí van tres, con su desmentido:

### Falsa 1: «El servicio api publica el puerto 3000 al exterior»

- **Fichero:** `docker-compose.yml`
- **Líneas que la desmienten:** líneas 13-26 (el bloque del servicio `api` no tiene ninguna clave `ports:`; solo `environment`, `depends_on` y `restart`).
- **Afirmación correcta:** el puerto 3000 es el puerto **interno** del contenedor `api`; solo es alcanzable desde la red Docker. El único puerto publicado al exterior es `8080` del servicio `proxy` (líneas 4-5: `- "8080:80"`).

### Falsa 2: «El worker consulta la base de datos PostgreSQL para generar las facturas»

- **Fichero:** `worker/worker.js`
- **Líneas que la desmienten:** líneas 1-3 (solo hace `require('redis')`; no hay `require('pg')` ni acceso a `DATABASE_URL`). Línea 10: la única "generación" de factura es un `console.log`.
- **Afirmación correcta:** el worker **no toca la base de datos** en absoluto; solo lee tareas de la cola Redis `cola:facturas` con `brPop` y las imprime por consola. No escribe ningún fichero ni registro de factura.

### Falsa 3: «La API usa JWT para autenticar las peticiones»

- **Fichero:** `api/src/server.js`
- **Líneas que la desmienten:** todo el fichero (33 líneas) — solo se importan `express`, `pg` y `redis` (líneas 1-3). No hay ningún `require('jsonwebtoken')` ni middleware de autenticación.
- **Afirmación correcta:** `jsonwebtoken` aparece en `api/package.json` (línea 13) como dependencia declarada, pero **nunca se usa** en el código. No hay autenticación alguna: `GET /libros` y `POST /pedidos` son endpoints abiertos.

### (Bonus) Falsa 4: «Hay dos servicios accesibles desde el exterior»

- **Fichero:** `docker-compose.yml`
- **Líneas que la desmienten:** solo el servicio `proxy` tiene bloque `ports:` (líneas 4-5). Los otros cuatro (`api`, `worker`, `db`, `cache`) carecen de esa clave.
- **Afirmación correcta:** solo **1** servicio (el proxy) es accesible desde fuera del equipo, en el puerto 8080.

---

## Reto (ampliación): prompt vago vs. prompt preciso

### Prompt vago

> «Explícame la arquitectura.»

Respuesta del agente:

> Es una tienda de libros con varias piezas: una web, una API en Node.js, una base de datos PostgreSQL, una caché Redis y un worker que procesa tareas. Todo va con Docker.

**Problemas:** no nombra los servicios con exactitud, no da números de puerto, no dice qué ficheros componen cada parte, no distingue qué está expuesto al exterior, no menciona dependencias. Es difícil verificar porque no concreta nada.

### Prompt preciso

> «Lee @docker-compose.yml, @api/src/server.js y @worker/worker.js. Devuélveme una **tabla Markdown** con una fila por servicio y estas columnas exactas: servicio, imagen, puerto publicado al exterior, puerto interno, volúmemes, dependencias, qué hace. Cita el fichero y la línea de donde sacas cada dato.»

Respuesta del agente:

> [Tabla completa y detallada, con citas de línea, idéntica a la del ejercicio 2]

**Qué cambia:**

| Aspecto | Prompt vago | Prompt preciso |
|---|---|---|
| Ficheros citados | Ninguno | `@docker-compose.yml`, `@api/src/server.js`, `@worker/worker.js` |
| Formato de salida | Texto libre | Tabla Markdown con columnas exactas |
| Verificabilidad | Baja: frases genéricas | Alta: cada celda cita fichero y línea |
| Errores del agente | Fácil que invente o genere generalidades | Los errores saltan al contrastar la cita con el fichero |

**Conclusión:** con modelos gratuitos, la clave no es la complejidad del prompt sino la **explícita**: citar ficheros (`@`), pedir un formato concreto (tabla, columnas) y exigir trazabilidad (fichero + línea). Así cada celda se puede comprobar con `git diff`/`cat`, y las afirmaciones falsas del ejercicio 7 se detectan de inmediato.

### Publicación del diagrama

`docs/arquitectura.md` está versionado en el repositorio Git del proyecto. Al subirlo a GitHub (o al repositorio de la unidad), los diagramas Mermaid se renderizan automáticamente en la vista de fichero.
