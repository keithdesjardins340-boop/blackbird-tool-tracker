# Local static server for the dashboard (no build step). Serves this web/ folder.
#   powershell -NoProfile -ExecutionPolicy Bypass -File web/serve.ps1
$port = if ($env:PORT) { $env:PORT } else { 8125 }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$port/"

$mime = @{
    ".html"        = "text/html"
    ".json"        = "application/json"
    ".webmanifest" = "application/manifest+json"
    ".js"          = "application/javascript"
    ".css"         = "text/css"
    ".svg"         = "image/svg+xml"
    ".png"         = "image/png"
    ".ico"         = "image/x-icon"
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response
        $path = $req.Url.LocalPath
        if ($path -eq "/") { $path = "/index.html" }
        $filePath = Join-Path $root ($path.TrimStart("/"))
        try {
            if (Test-Path $filePath -PathType Leaf) {
                $ext = [System.IO.Path]::GetExtension($filePath)
                $contentType = $mime[$ext]
                if (-not $contentType) { $contentType = "application/octet-stream" }
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentType = $contentType
                $res.ContentLength64 = $bytes.Length
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $res.StatusCode = 404
                $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                $res.OutputStream.Write($msg, 0, $msg.Length)
            }
        } catch {
        } finally {
            try { $res.OutputStream.Close() } catch {}
        }
    } catch {
    }
}
