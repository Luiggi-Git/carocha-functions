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
      let jsonText;
      if (typeof req.body === "string") {
        jsonText = req.body;
      } else {
        jsonText = JSON.stringify(req.body ?? {});
      }
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

