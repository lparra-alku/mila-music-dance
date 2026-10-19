// Copia la app web (una sola fuente de verdad) a www/ para el empaquetado nativo.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');     // carpeta del proyecto
const www  = join(here, '..', 'www');
if (!existsSync(www)) mkdirSync(www, { recursive: true });
for (const f of ['index.html', 'lame.min.js']) {
  copyFileSync(join(root, f), join(www, f));
  console.log('copiado', f);
}
