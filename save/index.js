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

    if (method === "OPTIONS") {
      context.res = { status: 204, headers: CORS };
      return;
    }

    const connStr = process.env.AzureWebJobsStorage;
    if (!connStr) {
      const msg = "AzureWebJobsStorage nao configurado";
      context.log.error("[save]", msg);
      context.res = jsonResponse(500, { error: msg });
      return;
    }

    const snapshotContainer = process.env.SNAPSHOT_CONTAINER || "data";
    const snapshotBlob = process.env.SNAPSHOT_BLOB || "carocha.json";
    const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
    const containerClient = blobServiceClient.getContainerClient(snapshotContainer);
    const blobClient = containerClient.getBlockBlobClient(snapshotBlob);

    if (method === "GET") {
      const snapshot = await readSnapshot(blobClient);
      if (!snapshot) {
        context.res = jsonResponse(404, { error: `Blob ${snapshotContainer}/${snapshotBlob} not found` });
        return;
      }
      context.res = jsonResponse(200, snapshot);
      return;
    }

    if (method !== "POST") {
      context.res = jsonResponse(405, { error: "Method Not Allowed" });
      return;
    }

    await containerClient.createIfNotExists();
    const body = parseBody(req.body);
    const current = (await readSnapshot(blobClient)) || emptySnapshot();
    const next = applyChange(current, body);
    const snapshot = recomputeStats(next);
    const jsonText = JSON.stringify(snapshot);

    await blobClient.upload(jsonText, Buffer.byteLength(jsonText), {
      overwrite: true,
      blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" }
    });

    context.res = jsonResponse(200, { ok: true });
  } catch (err) {
    context.log.error("save error:", err);
    context.res = jsonResponse(500, {
      error: String(err && err.message ? err.message : err),
      stack: err && err.stack ? String(err.stack) : undefined
    });
  }
};

function jsonResponse(status, payload) {
  return {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  };
}

function parseBody(body) {
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body && typeof body === "object" ? body : {};
}

function emptySnapshot() {
  return {
    stats: {
      custoProjetos: 0,
      custoManutencao: 0,
      custoTotal: 0,
      numProjetos: 0,
      numManutencoes: 0
    },
    projetos: [],
    manutencoes: [],
    fotoStorage: "inline"
  };
}

async function readSnapshot(blobClient) {
  if (!(await blobClient.exists())) return null;
  const dl = await blobClient.download();
  const text = await streamToString(dl.readableStreamBody);
  const parsed = parseBody(text);
  if (parsed && typeof parsed === "object" && parsed.kind === "batch") {
    return recomputeStats(applyChange(emptySnapshot(), parsed));
  }
  if (parsed && typeof parsed === "object" && parsed.kind === "snapshot" && parsed.payload && typeof parsed.payload === "object") {
    return recomputeStats(parsed.payload);
  }
  const raw = parsed && parsed.payload && Array.isArray(parsed.payload.projetos) ? parsed.payload : parsed;
  if (!raw || typeof raw !== "object") return emptySnapshot();
  if (!Array.isArray(raw.projetos) || !Array.isArray(raw.manutencoes)) return emptySnapshot();
  return recomputeStats(raw);
}

function applyChange(snapshot, body) {
  const current = recomputeStats(snapshot || emptySnapshot());
  const kind = String((body && body.kind) || "snapshot");
  if (kind === "snapshot") {
    return body && body.payload ? body.payload : body;
  }
  if (kind === "project-upsert" || kind === "project") {
    return applyProjectUpsert(current, {
      originalSlug: String(body.originalSlug || body.payload?.projeto || ""),
      payload: body.payload || {}
    });
  }
  if (kind === "project-delete") {
    return applyProjectDelete(current, String(body.originalSlug || ""));
  }
  if (kind === "maintenance-upsert" || kind === "maintenance") {
    return applyMaintenanceUpsert(current, {
      index: Number.isFinite(Number(body.index)) ? Number(body.index) : current.manutencoes.length,
      payload: body.payload || {}
    });
  }
  if (kind === "maintenance-delete") {
    return applyMaintenanceDelete(current, Number(body.index));
  }
  if (kind === "batch") {
    return applyBatch(current, body.payload || {});
  }
  throw new Error(`Unsupported save kind: ${kind}`);
}

function applyBatch(snapshot, payload) {
  let next = recomputeStats(snapshot);
  for (const op of payload.projetoOps || []) {
    next = op.op === "delete"
      ? applyProjectDelete(next, String(op.originalSlug || ""))
      : applyProjectUpsert(next, op);
  }
  for (const op of payload.manutencaoOps || []) {
    next = op.op === "delete"
      ? applyMaintenanceDelete(next, Number(op.index))
      : applyMaintenanceUpsert(next, op);
  }
  return next;
}

function applyProjectUpsert(snapshot, op) {
  const projetos = Array.isArray(snapshot.projetos) ? [...snapshot.projetos] : [];
  const originalSlug = String(op.originalSlug || "");
  const payload = op.payload && typeof op.payload === "object" ? op.payload : {};
  const nextSlug = String(payload.projeto || originalSlug || "").trim();
  const existingIndex = projetos.findIndex((proj) => String(proj && proj.projeto || "") === originalSlug);
  const fallbackIndex = existingIndex >= 0 ? existingIndex : projetos.findIndex((proj) => String(proj && proj.projeto || "") === nextSlug);
  const index = fallbackIndex;
  const existing = index >= 0 ? projetos[index] : {};
  const merged = { ...existing, ...payload };
  if (!merged.projeto) merged.projeto = nextSlug || originalSlug;
  if (index >= 0) projetos[index] = merged;
  else projetos.push(merged);
  return { ...snapshot, projetos };
}

function applyProjectDelete(snapshot, originalSlug) {
  const projetos = (snapshot.projetos || []).filter((proj) => String(proj && proj.projeto || "") !== originalSlug);
  return { ...snapshot, projetos };
}

function applyMaintenanceUpsert(snapshot, op) {
  const manutencoes = Array.isArray(snapshot.manutencoes) ? [...snapshot.manutencoes] : [];
  const index = Number.isFinite(Number(op.index)) ? Math.max(0, Number(op.index)) : manutencoes.length;
  const payload = op.payload && typeof op.payload === "object" ? op.payload : {};
  const targetIndex = Math.min(index, manutencoes.length);
  const existing = targetIndex < manutencoes.length ? manutencoes[targetIndex] : {};
  const merged = { ...existing, ...payload };
  if (targetIndex < manutencoes.length) manutencoes[targetIndex] = merged;
  else manutencoes.push(merged);
  return { ...snapshot, manutencoes };
}

function applyMaintenanceDelete(snapshot, index) {
  if (!Number.isFinite(index) || index < 0) return snapshot;
  const manutencoes = [...(snapshot.manutencoes || [])];
  if (index < manutencoes.length) manutencoes.splice(index, 1);
  return { ...snapshot, manutencoes };
}

function recomputeStats(payload) {
  const base = payload && typeof payload === "object" ? payload : emptySnapshot();

  const projetos = (Array.isArray(base.projetos) ? base.projetos : []).map((proj) => {
    const itens = Array.isArray(proj && proj.itens) ? proj.itens : [];
    const custoTotal = itens.reduce((acc, it) => {
      const qty = Number(it && it.quantidade != null ? it.quantidade : 1) || 1;
      const cost = Number(it && it.custo != null ? it.custo : 0) || 0;
      return acc + qty * cost;
    }, 0);
    return { ...proj, itens, custoTotal, numItens: itens.length };
  });

  const custoProjetos = projetos.reduce((sum, proj) => sum + (Number(proj.custoTotal) || 0), 0);

  const manutencoes = (Array.isArray(base.manutencoes) ? base.manutencoes : []).map((m) => {
    const linhas = Array.isArray(m && m.linhas) && m.linhas.length
      ? m.linhas
      : [{
          custo: m && m.custo || 0,
          data: m && m.data || null,
          item: m && m.item || "",
          quantidade: m && m.quantidade != null ? m.quantidade : 1,
          observacoes: m && m.observacoes || ""
        }];
    const custo = linhas.reduce((sum, line) => {
      const qty = Number(line && line.quantidade != null ? line.quantidade : 1) || 1;
      const cost = Number(line && line.custo != null ? line.custo : 0) || 0;
      return sum + qty * cost;
    }, 0);
    return { ...m, linhas, custo };
  });

  const custoManutencao = manutencoes.reduce((sum, m) => sum + (Number(m.custo) || 0), 0);

  return {
    ...base,
    projetos,
    manutencoes,
    fotoStorage: base.fotoStorage || "inline",
    stats: {
      custoProjetos,
      custoManutencao,
      custoTotal: custoProjetos + custoManutencao,
      numProjetos: projetos.length,
      numManutencoes: manutencoes.length
    }
  };
}

async function streamToString(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", (d) => chunks.push(Buffer.from(d)));
    readable.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    readable.on("error", reject);
  });
}
