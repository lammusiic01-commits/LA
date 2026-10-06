# Техническая архитектура Localis

## Единственная локальная модель

**LamV1.0** (`lam-v1.0`) — единственная встроенная локальная модель и единственный локальный inference backend. В её основе Qwen3-4B-Instruct-2507 Q4_K_M (GGUF); это открытые сторонние конвертированные веса, а не веса Claude или Manus. Веса неизменны: tools и файловые/API-возможности реализуются в desktop-приложении; сохранённые заметки и retrieval-контекст не дообучают модель.

На Windows C++-launcher определяет доступную системную RAM, количество CPU-потоков и общую память NVIDIA GPU, выбирает параметры offload и запускает включённый в комплект `llama-server.exe`. Он не реализует модельную арифметику и не является самостоятельным inference engine. llama.cpp выполняет inference и предоставляет OpenAI-compatible API только на loopback-интерфейсе.

```text
Electron renderer (UI, без Node API)
       │ узкий IPC через contextBridge
       ▼
Electron main (конфигурация, разрешения, run lifecycle, файловая область)
       ├── Localis C++ launcher (подбор профиля и управление процессом)
       │       └── включённый llama.cpp server + модель LamV1.0
       │              └── http://127.0.0.1:<port>/v1/chat/completions
       ├── проверенные публичные web endpoints
       ├── выбранные GitHub / Google / Instagram API
       ├── настроенные MCP Streamable HTTP servers
       ├── необязательные облачные AI providers по отдельному выбору
       ├── локальные файлы и документы
       ├── AUTOMATIC1111 / Forge / ComfyUI loopback API
       └── ffmpeg (необязательно)
```

Путь `release-assets/` подготавливается `scripts/prepare-windows-engine.ps1`: сценарий фиксирует версии/ревизии и SHA-256, получает runtime, модель и лицензию, компилирует launcher и сохраняет manifest. Electron Builder включает весь каталог как `resources/localis-bundle`; запуск готового приложения не скачивает веса. `npm run dist:win` сначала подготавливает assets и app directory, затем упаковывает их в один Inno Setup x64 installer. Для single-file payload больше 2 ГБ требуется Inno Setup 6.6+; сборку на Windows CI необходимо успешно завершить, прежде чем считать конкретный установщик проверенным.

## Цикл агента

1. Renderer отправляет текст, user/assistant историю, проект, выбранные в чате connector/provider IDs и ID разрешённых вложений. Main повторно фильтрует подключённые IDs; system/tool сообщения из renderer не принимаются.
2. Main проверяет и при необходимости запускает только `LocalisEngine`, затем формирует prompt из LamV1.0, проекта, локальной сводки памяти, включённых skills и фактически выбранных сервисов.
3. Агент вызывает `POST /v1/chat/completions` с model alias `lam-v1.0`, native function-tool schemas, `tool_choice: auto` и `stream: true`. Renderer получает текстовые SSE chunks и шаги в Activity sidebar.
4. Каждый streamed tool call собирается по индексу и ID; JSON-аргументы парсятся и валидируются до выполнения. В режиме Ask перед инструментом показывается карточка с summary/аргументами. Full access требует отдельного системного подтверждения; он отключает последующие prompts и не является OS-песочницей.
5. Результат инструмента возвращается в OpenAI-compatible истории как assistant `tool_calls` и tool-сообщение с соответствующим `tool_call_id`. Ошибки остаются в activity log/ответе и не превращаются в ложный успех.
6. Лимиты — до 8 agent rounds и 12 вызовов инструментов за запрос. Повтор локального запроса ограничен; облачный fallback возможен только при отдельной настройке и разрешении передачи контекста.

## IPC и границы доверия

- Renderer использует `contextIsolation`, `sandbox`, `nodeIntegration: false`, локальную CSP, узкий allowlist preload-функций и проверку IPC sender.
- Удалённые страницы открываются в отдельном `WebContentsView` и Electron session без preload/Node API; pop-ups и браузерные разрешения отключены. Web-инструменты проверяют протокол, DNS/IP и redirects; частные диапазоны запрещены.
- MCP endpoints хранятся в настройках, bearer credentials — в локальном vault. HTTP разрешён только для loopback; перед remote-вызовом проверяется публичный адрес, redirects с auth-заголовками запрещены.
- GitHub agent import не клонирует репозиторий: получает ограниченный набор небольших Markdown-файлов через GitHub API и хранит как текстовые инструкции. Код не запускается; пользователь может просмотреть, отключить или удалить импорт.
- Plugins хранятся как текстовые instructions, а не исполняемые JavaScript-модули.

## Файловая безопасность

- В обычном режиме файловые инструменты работают внутри выбранного workspace/project. Пути нормализуются, проверяются realpath и symlink; запись не создаёт каталоги за пределами workspace.
- Full access — не OS sandbox. Этот режим разрешает main process использовать пути за пределами workspace и запускать предусмотренные приложением команды с полномочиями пользователя Windows; вредоносная команда может повредить данные.
- Процессы ограничены таймаутом и объёмом вывода. Папка проекта проверяется как потомок workspace; проекты имеют отдельные корни и чаты.

## Процессы, секреты и память

- Локальный сервер слушает только `127.0.0.1` на выделенном порту. C++-launcher скрыто запускает дочерний llama.cpp server и привязывает его к Windows Job Object с `KILL_ON_JOB_CLOSE`. Main останавливает launcher при завершении приложения.
- Настройки, история, память, проекты, plugins и реестр GitHub skills хранятся в Electron userData.
- API keys, OAuth refresh/access tokens и connector/MCP bearer tokens хранятся в `secrets.enc` через Electron `safeStorage`; если системное шифрование недоступно, приложение не сохраняет секрет открытым текстом.
- Сообщения могут содержать личную информацию. При выбранной интеграции контекст передаётся соответствующей службе; внешнему AI отправляется выбранный контекст. DPAPI-секреты привязаны к профилю и обычно не переносятся на другой ПК.
- Память — локальная сводка недавних запросов/результатов и отдельные заметки. Это retrieval-контекст, не fine-tuning; данные можно очистить в настройках.

## Форматы и внешние зависимости

- UTF-8-файлы, DOCX (`docx`), PDF (`pdfkit`), XLSX (`exceljs`), PPTX (`pptxgenjs`).
- CSV/TSV/JSON/JSONL анализируются локально без изменения исходных файлов.
- Изображения создаются при наличии локального A1111/Forge или ComfyUI; MP4-слайдшоу — из кадров с ffmpeg. LamV1.0 в этой сборке текстовая: анализ изображений и text-to-video не реализованы.
- Windows Inno Setup installer — x64; пакет включает модель и C++ launcher. Inno Setup 6.6 снял прежний предел в 2 ГБ для single-file setup; см. [официальную историю версий](https://jrsoftware.org/files/is6-whatsnew.htm). Тесты запускаются `node --test` и GitHub Actions на Windows.
