// /api/save
const { BlobServiceClient } = require("@azure/storage-blob");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type"
};

module.exports = async function (context, req) {
  try {
    const method = (req.method || "GET").toUpperCase();

    // Preflight CORS
    if (method === "OPTIONS") {
      context.res = { status: 204, headers: CORS };
      return;
    }

    const connStr = process.env.AzureWebJobsStorage;
    const snapshotContainer = process.env.SNAPSHOT_CONTAINER || "data";
    const snapshotBlob = process.env.SNAPSHOT_BLOB || "carocha.json";

    const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
    const containerClient = blobServiceClient.getContainerClient(snapshotContainer);
    const blobClient = containerClient.getBlockBlobClient(snapshotBlob);

    if (method === "GET") {
      if (!(await blobClient.exists())) {
        context.res = { status: 404, headers: { ...CORS }, body: { error: `Blob ${snapshotContainer}/${snapshotBlob} not found` } };
        return;
      }
      const dl = await blobClient.download();
      const text = await streamToString(dl.readableStreamBody);
      context.res = { status: 200, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" }, body: text };
      return;
    }

    if (method === "POST") {
      await containerClient.createIfNotExists();

      // Corpo pode vir como string (fallback) ou objeto já parseado
      const incoming = typeof req.body === "string" ? safeJsonParse(req.body) : (req.body ?? {});

      // Carrega snapshot atual para merge (para evitar reenviar dataUrl de fotos já guardadas)
      let merged = incoming;
      try {
        const prev = await loadCurrentSnapshot(blobClient);
        merged = mergeSnapshots(prev, incoming);
      } catch (err) {
        context.log.warn("merge skipped, unable to load existing snapshot:", err?.message || err);
      }

      const jsonText = JSON.stringify(merged ?? {});
      await blobClient.upload(jsonText, Buffer.byteLength(jsonText), {
        blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" }
      });
      context.res = { status: 200, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ ok: true }) };
      return;
    }

    context.res = { status: 405, headers: { ...CORS }, body: { error: "Method Not Allowed" } };
  } catch (err) {
    context.log.error("save error:", err);
    context.res = { status: 500, headers: { ...CORS }, body: { error: String(err?.message || err) } };
  }
};

async function streamToString(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", d => chunks.push(Buffer.from(d)));
    readable.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    readable.on("error", reject);
  });
}

function safeJsonParse(text, fallback = {}) {
  try { return JSON.parse(text); }
  catch { return fallback; }
}

async function loadCurrentSnapshot(blobClient) {
  if (!(await blobClient.exists())) return null;
  const dl = await blobClient.download();
  const text = await streamToString(dl.readableStreamBody);
  return safeJsonParse(text, null);
}

function mergeSnapshots(prev, incoming) {
  if (!incoming || typeof incoming !== "object") return incoming;
  if (!prev || typeof prev !== "object") return incoming;

  const prevIndex = buildPhotoIndex(prev);
  const payload = incoming.payload ?? incoming; // suporta ambos formatos {kind, payload} ou snapshot cru
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.projetos)) return incoming;

  const mergedProjetos = payload.projetos.map((proj) => {
    if (!proj || typeof proj !== "object") return proj;
    const key = proj.projeto || proj.nome || "";
    const prevFotos = prevIndex.get(key);
    if (!prevFotos || !Array.isArray(proj.fotos)) return proj;

    const fotos = proj.fotos.map((foto) => {
      if (!foto || typeof foto !== "object" || !foto.id) return foto;
      if (foto.dataUrl) return foto; // nova ou alterada
      const prevFoto = prevFotos.get(foto.id);
      if (prevFoto?.dataUrl) return { ...foto, dataUrl: prevFoto.dataUrl };
      return foto;
    });
    return { ...proj, fotos };
  });

  const mergedPayload = { ...payload, projetos: mergedProjetos };
  return "kind" in incoming ? { ...incoming, payload: mergedPayload } : mergedPayload;
}

function buildPhotoIndex(snapshot) {
  const map = new Map();
  const payload = snapshot.payload ?? snapshot;
  for (const proj of payload?.projetos || []) {
    if (!proj || typeof proj !== "object") continue;
    const key = proj.projeto || proj.nome || "";
    if (!key) continue;
    const fotosMap = new Map();
    for (const foto of proj.fotos || []) {
      if (foto && typeof foto === "object" && foto.id) {
        fotosMap.set(foto.id, foto);
      }
    }
    map.set(key, fotosMap);
  }
  return map;
}

