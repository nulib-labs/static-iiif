import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  manifestIdPattern,
  sanitizeManifestIdentifier,
  manifestObjectKey,
  createManifestTemplate,
} = require('../app/shared/manifest.js');

const projectRoot = path.resolve(__dirname, '..');
const directoryRoots = {
  source: path.join(projectRoot, 'source'),
  output: path.join(projectRoot, 'output'),
};
const presentationRoot = path.join(directoryRoots.output, 'presentation');
const manifestRoot = path.join(presentationRoot, 'manifest');
const manifestBaseUrl = (process.env.IIIF_BASE_URL || 'http://localhost:5173/iiif/output').replace(/\/$/, '');

const contentTypes = {
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

async function ensureManifestRoot() {
  await fsp.mkdir(manifestRoot, { recursive: true });
}

function manifestFilePath(identifier) {
  return path.join(manifestRoot, identifier, 'manifest.json');
}

async function manifestExists(identifier) {
  const filePath = manifestFilePath(identifier);
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readManifest(identifier) {
  const filePath = manifestFilePath(identifier);
  const payload = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(payload);
}

async function writeManifest(identifier, manifest) {
  const filePath = manifestFilePath(identifier);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf8');
  return filePath;
}

function manifestSummary(identifier, manifest) {
  const label = manifest?.label?.none?.[0] || '';
  return {
    identifier,
    label,
    manifestUrl: manifest?.id || '',
    relativePath: manifestObjectKey(identifier),
    itemCount: Array.isArray(manifest?.items) ? manifest.items.length : 0,
  };
}

function manifestDetail(identifier, manifest) {
  return {
    ...manifestSummary(identifier, manifest),
    manifest,
  };
}

async function listManifestSummaries() {
  await ensureManifestRoot();
  let entries = [];
  try {
    entries = await fsp.readdir(manifestRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const manifest = await readManifest(entry.name);
          return manifestSummary(entry.name, manifest);
        } catch (error) {
          return null;
        }
      }),
  );

  return summaries.filter(Boolean).sort((a, b) => a.label.localeCompare(b.label) || a.identifier.localeCompare(b.identifier));
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1e6) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readRequestBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('Invalid JSON payload');
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

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
      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;
      const method = req.method || 'GET';
      const segments = pathname.split('/').filter(Boolean);

      if (segments[0] === 'api' && segments[1] === 'manifests') {
        await ensureManifestRoot();
        if (segments.length === 2) {
          if (method === 'GET') {
            const manifests = await listManifestSummaries();
            sendJson(res, 200, { manifests });
            return;
          }
          if (method === 'POST') {
            let identifier;
            try {
              const body = await parseJsonBody(req);
              identifier = sanitizeManifestIdentifier(body.identifier || body.id);
              const label = (body.label || '').trim();
              if (!label) {
                sendJson(res, 400, { error: 'Label is required' });
                return;
              }
              const exists = await manifestExists(identifier);
              if (exists) {
                sendJson(res, 409, { error: 'A manifest with that id already exists' });
                return;
              }
              const manifest = createManifestTemplate({
                baseUrl: manifestBaseUrl,
                identifier,
                label,
              });
              await writeManifest(identifier, manifest);
              sendJson(res, 201, { manifest: manifestDetail(identifier, manifest) });
              return;
            } catch (error) {
              if (error.message === 'Invalid JSON payload') {
                sendJson(res, 400, { error: error.message });
                return;
              }
              sendJson(res, 400, { error: error.message });
              return;
            }
          }
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        const identifierSegment = segments[2];
        if (!identifierSegment) {
          sendJson(res, 400, { error: 'Manifest id is required' });
          return;
        }

        let identifier;
        try {
          identifier = sanitizeManifestIdentifier(decodeURIComponent(identifierSegment));
        } catch (error) {
          sendJson(res, 400, { error: error.message });
          return;
        }

        if (segments.length === 3) {
          if (method === 'GET') {
            try {
              const manifest = await readManifest(identifier);
              sendJson(res, 200, { manifest: manifestDetail(identifier, manifest) });
              return;
            } catch (error) {
              if (error.code === 'ENOENT') {
                sendJson(res, 404, { error: 'Manifest not found' });
                return;
              }
              sendJson(res, 500, { error: error.message });
              return;
            }
          }
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        if (segments.length === 4 && segments[3] === 'items') {
          if (method === 'PUT') {
            try {
              const body = await parseJsonBody(req);
              if (!Array.isArray(body.items)) {
                sendJson(res, 400, { error: 'items must be an array' });
                return;
              }
              const manifest = await readManifest(identifier);
              manifest.items = body.items;
              await writeManifest(identifier, manifest);
              sendJson(res, 200, { manifest: manifestDetail(identifier, manifest) });
              return;
            } catch (error) {
              if (error.message === 'Invalid JSON payload') {
                sendJson(res, 400, { error: error.message });
                return;
              }
              if (error.code === 'ENOENT') {
                sendJson(res, 404, { error: 'Manifest not found' });
                return;
              }
              sendJson(res, 500, { error: error.message });
              return;
            }
          }
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        sendJson(res, 404, { error: 'Unknown manifest endpoint' });
        return;
      }

      if (pathname.startsWith('/api/tree')) {
        const { searchParams } = parsedUrl;
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

      if (pathname.startsWith('/iiif/')) {
        const iiifSegments = pathname.replace(/^\/+/u, '').split('/');
        const scope = iiifSegments[1];
        const root = directoryRoots[scope];
        if (!root) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        const relativePath = iiifSegments.slice(2).join('/');
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
  define: {
    'import.meta.env.VITE_BACKEND': JSON.stringify(process.env.VITE_BACKEND || 'local'),
    'import.meta.env.VITE_IIIF_BASE_URL': JSON.stringify(process.env.VITE_IIIF_BASE_URL || ''),
    'import.meta.env.VITE_MANIFEST_API_URL': JSON.stringify(process.env.VITE_MANIFEST_API_URL || ''),
    'import.meta.env.VITE_STORAGE_BUCKET': JSON.stringify(process.env.VITE_STORAGE_BUCKET || ''),
    'import.meta.env.VITE_STORAGE_REGION': JSON.stringify(process.env.VITE_STORAGE_REGION || ''),
    'import.meta.env.VITE_STORAGE_IDENTITY_POOL_ID': JSON.stringify(process.env.VITE_STORAGE_IDENTITY_POOL_ID || ''),
  },
  server: {
    fs: {
      allow: [projectRoot],
    },
  },
});
