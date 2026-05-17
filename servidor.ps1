# Servidor HTTP simples para o Consultório App
# Roda em http://localhost:3000

$port = 3000
$root = $PSScriptRoot

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()

Write-Host ""
Write-Host "  ✅ Consultório App rodando!" -ForegroundColor Green
Write-Host "  👉 Abra no Chrome: http://localhost:$port" -ForegroundColor Cyan
Write-Host ""
Write-Host "  (Pressione Ctrl+C para parar o servidor)" -ForegroundColor Gray
Write-Host ""

# Abre o Chrome automaticamente
Start-Process "chrome.exe" "http://localhost:$port"

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".png"  = "image/png"
    ".ico"  = "image/x-icon"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml; charset=utf-8"
    ".webmanifest" = "application/manifest+json; charset=utf-8"
    ".woff"  = "font/woff"
    ".woff2" = "font/woff2"
}

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response

        $urlPath = $req.Url.LocalPath
        if ($urlPath -eq "/") { $urlPath = "/index.html" }

        $filePath = Join-Path $root $urlPath.TrimStart("/").Replace("/", "\")

        if (Test-Path $filePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($filePath)
            $res.ContentType = if ($mimeTypes[$ext]) { $mimeTypes[$ext] } else { "application/octet-stream" }
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 - Arquivo nao encontrado")
            $res.OutputStream.Write($msg, 0, $msg.Length)
        }

        $res.OutputStream.Close()
    } catch {
        if ($listener.IsListening) {
            Write-Host "Erro: $_" -ForegroundColor Red
        }
    }
}
