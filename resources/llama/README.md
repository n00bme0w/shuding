# Local embedding runtime

Place the platform-specific `llama-server` binary and the BGE-M3 GGUF model in
this directory when building a distributable application:

- Linux/macOS: `llama-server`
- Windows: `llama-server.exe`
- Model: `bge-m3.gguf`

The Electron main process starts the server automatically on `127.0.0.1`.
Development and packaged builds can override these paths with
`SHUDING_LLAMA_SERVER` and `SHUDING_BGE_M3_MODEL`.
