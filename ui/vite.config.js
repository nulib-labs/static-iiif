import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(__dirname, '..');
const directoryRoots = {
  source: path.join(projectRoot, 'source'),
  output: path.join(projectRoot, 'output'),
};

const contentTypes = {
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

async function readDirectoryTree(target, base) {
  let entries = [];
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch (error) {
    return [];
  }

  const nodes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(target, entry.name);
      const relativePath = path.relative(base, entryPath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        return {
          type: 'directory',
          name: entry.name,
          path: relativePath,
          children: await readDirectoryTree(entryPath, base),
        };
      }
      return {
        type: 'file',
        name: entry.name,
        path: relativePath,
      };
    }),
  );

  return nodes.sort((a, b) => a.name.localeCompare(b.name));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = contentTypes[ext] || 'application/octet-stream';
  const stream = fs.createReadStream(filePath);
  res.setHeader('Content-Type', contentType);
  stream.on('error', () => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  stream.pipe(res);
}

function createApiMiddleware() {
  return async function middleware(req, res, next) {
    if (!req.url) return next();
    try {
      if (req.url.startsWith('/api/tree')) {
        const { searchParams } = new URL(req.url, 'http://localhost');
        const type = searchParams.get('type');
        const root = directoryRoots[type];
        if (!root) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Unknown directory type' }));
          return;
        }
        const tree = await readDirectoryTree(root, root);
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            root: type,
            tree: {
              type: 'directory',
              name: type,
              path: '',
              children: tree,
            },
          }),
        );
        return;
      }

      if (req.url.startsWith('/iiif/')) {
        const segments = req.url.replace(/^\/+/u, '').split('/');
        const scope = segments[1];
        const root = directoryRoots[scope];
        if (!root) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        const relativePath = segments.slice(2).join('/');
        const candidatePath = path.join(root, ...relativePath.split('/'));
        if (!candidatePath.startsWith(root)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        serveFile(res, candidatePath);
        return;
      }
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error.message }));
      return;
    }

    next();
  };
}

function directoryApiPlugin() {
  return {
    name: 'directory-api',
    configureServer(server) {
      server.middlewares.use(createApiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createApiMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [directoryApiPlugin(), react()],
  server: {
    fs: {
      allow: [projectRoot],
    },
  },
});
