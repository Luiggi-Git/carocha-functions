const { app } = require("@azure/functions");
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions
} = require("@azure/storage-blob");

// util: extrai accountName/Key da connection string
function parseConnString(cs) {
  const map = Object.fromEntries(
    cs.split(";").filter(Boolean).map(p => p.split("=").map(s => s.trim()))
  );
  return { accountName: map.AccountName, accountKey: map.AccountKey };
}

// GET /api/getUploadSas?filename=xxx.ext  -> { uploadUrl, expiresOn }
app.http("getUploadSas", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    const filename = req.query.get("filename");
    if (!filename) return { status: 400, jsonBody: { error: "missing filename" } };

    const conn = process.env.AzureWebJobsStorage;
    const container = process.env.PHOTOS_CONTAINER || "photos";
    const { accountName, accountKey } = parseConnString(conn);

    const cred = new StorageSharedKeyCredential(accountName, accountKey);
    const expiresOn = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    const sas = generateBlobSASQueryParameters(
      {
        containerName: container,
        blobName: filename,
        permissions: BlobSASPermissions.parse("cw"), // create + write
        startsOn: new Date(Date.now() - 60 * 1000),
        expiresOn
      },
      cred
    ).toString();

    const uploadUrl =
      `https://${accountName}.blob.core.windows.net/${container}/${encodeURIComponent(filename)}?${sas}`;

    return { status: 200, jsonBody: { uploadUrl, expiresOn } };
  }
});

// GET /api/listPhotos -> { items:[{name,size,url}], expiresOn }
app.http("listPhotos", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async () => {
    const conn = process.env.AzureWebJobsStorage;
    const container = process.env.PHOTOS_CONTAINER || "photos";
    const { accountName, accountKey } = parseConnString(conn);

    const svc = BlobServiceClient.fromConnectionString(conn);
    const cc = svc.getContainerClient(container);

    const cred = new StorageSharedKeyCredential(accountName, accountKey);
    const expiresOn = new Date(Date.now() + 10 * 60 * 1000);

    const items = [];
    for await (const b of cc.listBlobsFlat()) {
      const sas = generateBlobSASQueryParameters(
        {
          containerName: container,
          blobName: b.name,
          permissions: BlobSASPermissions.parse("r"),
          startsOn: new Date(Date.now() - 60 * 1000),
          expiresOn
        },
        cred
      ).toString();

      items.push({
        name: b.name,
        size: b.properties.contentLength,
        url: `https://${accountName}.blob.core.windows.net/${container}/${encodeURIComponent(b.name)}?${sas}`
      });
    }
    return { status: 200, jsonBody: { items, expiresOn } };
  }
});
# acrescenta deletePhoto no fim do index.js
cat >> index.js <<'EOF'

// --- deletePhoto (apagar blob) ---
const { BlobServiceClient } = require("@azure/storage-blob");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

app.http("deletePhoto", {
  methods: ["DELETE", "GET"],   // GET só para facilitar testes rápidos
  authLevel: "anonymous",
  route: "deletePhoto",
  handler: async (req, ctx) => {
    try {
      const url = new URL(req.url);
      const name = (url.searchParams.get("name") || "").trim();

      if (!name) {
        return {
          status: 400,
          jsonBody: { error: "Parâmetro 'name' é obrigatório" }
        };
      }

      const conn = requireEnv("AzureWebJobsStorage");
      const containerName = process.env.PHOTOS_CONTAINER || "photos";

      const svc = BlobServiceClient.fromConnectionString(conn);
      const container = svc.getContainerClient(containerName);
      const blob = container.getBlockBlobClient(name);

      const exists = await blob.exists();
      if (!exists) {
        return {
          status: 404,
          jsonBody: { error: "Blob não encontrado", name }
        };
      }

      await blob.delete();
      return { status: 200, jsonBody: { ok: true, name } };
    } catch (err) {
      ctx.error?.("Erro em deletePhoto:", err);
      return {
        status: 500,
        jsonBody: { error: "Erro interno", detail: String(err?.message || err) }
      };
    }
  }
});
EOF
