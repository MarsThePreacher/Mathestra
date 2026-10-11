import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Puts the logo symbol into every page once, so any <use href="#mathestra-logo"> can draw it in currentColor. */
function brandSprite(): Plugin {
  const file = resolve(__dirname, 'src/brand-sprite.html');
  return {
    name: 'mathestra-brand-sprite',
    transformIndexHtml(html) {
      return html.replace('<!-- brand-sprite -->', readFileSync(file, 'utf8').trim());
    },
  };
}

/** House style: no em dashes anywhere on the site, including inside third-party libraries' strings. */
function noEmDashes(): Plugin {
  return {
    name: 'mathestra-no-em-dashes',
    renderChunk(code) {
      const EM_DASH = String.fromCharCode(0x2014);
      return code.includes(EM_DASH) ? { code: code.replaceAll(EM_DASH, '-'), map: null } : null;
    },
  };
}

export default defineConfig({
  // Served from the site root: the landing page at /, the calculator at /app/.
  base: '/',
  plugins: [brandSprite(), noEmDashes()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app/index.html'),
        privacy: resolve(__dirname, 'privacy/index.html'),
        terms: resolve(__dirname, 'terms/index.html'),
        notFound: resolve(__dirname, '404.html'),
      },
    },
  },
});
