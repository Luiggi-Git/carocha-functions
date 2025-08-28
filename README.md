# Carocha Functions

Node.js Azure Functions (v4) para gestão de fotos:
- `GET /api/getUploadSas?filename=nome.ext` -> devolve URL SAS para upload direto ao Blob
- `GET /api/listPhotos` -> lista blobs do container

Requer:
- `AzureWebJobsStorage` (connection string da Storage)
- `PHOTOS_CONTAINER` (ex.: "photos")
- CORS com `http://localhost:5173` na Function App
