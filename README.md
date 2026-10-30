# Java Live

Editor de Java en el navegador: escribes a la izquierda y el programa se compila y se ejecuta solo a la derecha.
Producción: <https://olcas.app/java>

## Cómo funciona
- `server.js` (Node, sin dependencias) sirve la web y expone `POST /api/run`.
- Cada ejecución crea un trabajo temporal, compila con `javac` y lanza `java` dentro de una unidad transitoria de
  **systemd** (`deploy/java-live-run`): usuario dinámico sin privilegios, sin red, raíz mínima con solo las librerías
  del JDK, 512 MB al compilar y 256 MB al ejecutar, 64 tareas, 5 s de ejecución y ficheros de 4 MB como máximo.
- Límites del servidor: ráfaga de 20 ejecuciones y 0,7/s por IP, 3 ejecuciones a la vez con cola de 8,
  código ≤ 50 KB, entrada ≤ 10 KB, salida ≤ 64 KB.
- El botón **Descargar .java** (o Ctrl+S) guarda el código con el nombre de su clase pública.

## Desarrollo local
```bash
RUNNER=direct JAVA_HOME_DIRECT=/usr/lib/jvm/java-21-openjdk node server.js   # http://127.0.0.1:4012
npm test
```
`RUNNER=direct` ejecuta sin aislamiento: **solo para desarrollo local**. En producción es `RUNNER=sandbox`.

## Despliegue
Push a `main` → GitHub Actions (pruebas + paquete) → SSH con llave restringida a `java-live-deploy` →
activación atómica en `/var/www/java-live/current`, PM2 como usuario `javalive` y comprobación de `/api/health`
con vuelta atrás si falla.

`deploy/setup.sh` prepara el VPS una sola vez (JDK 21, usuario, tmpfs de trabajos, sudoers). El script de aislamiento
y el de despliegue se instalan a mano en `/usr/local/sbin` (no los actualiza el CI a propósito: quien pueda hacer
push no debe poder cambiar lo que se ejecuta como root).
