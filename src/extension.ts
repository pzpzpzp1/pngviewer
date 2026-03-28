import * as path from "path";
import * as vscode from "vscode";

const VIEW_TYPE = "pngViewer.png";
const ALPHA_OPTIONS_STORAGE_KEY = "pngViewer.alphaOptions";

type AlphaOptions = {
    useAlpha: boolean;
};

const DEFAULT_ALPHA_OPTIONS: AlphaOptions = {
    useAlpha: true,
};

export function activate(context: vscode.ExtensionContext): void {
    const provider = new PngEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
            supportsMultipleEditorsPerDocument: false,
        }),
    );
}

export function deactivate(): void {}

class PngEditorProvider implements vscode.CustomReadonlyEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    private normalizeOptions(value: unknown): AlphaOptions {
        const candidate = (value ?? {}) as Partial<AlphaOptions>;
        return {
            useAlpha:
                typeof candidate.useAlpha === "boolean"
                    ? candidate.useAlpha
                    : DEFAULT_ALPHA_OPTIONS.useAlpha,
        };
    }

    private getSavedOptions(): AlphaOptions {
        const stored = this.context.globalState.get<AlphaOptions | undefined>(ALPHA_OPTIONS_STORAGE_KEY);
        return this.normalizeOptions(stored);
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken,
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.dirname(document.uri.fsPath))],
        };

        const currentOptions = this.getSavedOptions();
        const imageUri = webviewPanel.webview.asWebviewUri(document.uri);
        webviewPanel.webview.html = this.getViewerHtml(
            path.basename(document.uri.fsPath),
            imageUri.toString(),
            currentOptions,
        );

        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (message?.type !== "saveDefaults") {
                return;
            }

            const nextDefaults = this.normalizeOptions(message.options);
            await this.context.globalState.update(ALPHA_OPTIONS_STORAGE_KEY, nextDefaults);
            vscode.window.showInformationMessage(
                `PNG Viewer: Saved default alpha setting (${nextDefaults.useAlpha ? "enabled" : "disabled"})`,
            );
            await webviewPanel.webview.postMessage({ type: "defaultsSaved" });
        });
    }

    private getViewerHtml(filename: string, imageSrc: string, initialOptions: AlphaOptions): string {
        const initialOptionsJson = JSON.stringify(initialOptions);
        const imageSrcJson = JSON.stringify(imageSrc);
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PNG Viewer</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            height: 100vh;
            width: 100vw;
            overflow: hidden;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
        }
        .viewer-root {
            display: grid;
            grid-template-rows: auto 1fr;
            height: 100%;
            width: 100%;
        }
        .toolbar {
            display: flex;
            align-items: center;
            gap: 12px;
            min-height: 30px;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editorWidget-background);
        }
        .title {
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 50vw;
        }
        .control {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            user-select: none;
            cursor: pointer;
        }
        button {
            border: 1px solid var(--vscode-button-border, transparent);
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            padding: 4px 10px;
            cursor: pointer;
            border-radius: 2px;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .status {
            margin-left: auto;
            opacity: 0.9;
            font-size: 12px;
        }
        .status.error {
            color: var(--vscode-errorForeground);
        }
        .content {
            min-height: 0;
            height: 100%;
        }
        .image-container {
            width: 100%;
            height: 100%;
            overflow: hidden;
            position: relative;
            cursor: default;
            background-color: #d9d9d9;
            background-image:
                linear-gradient(45deg, #c4c4c4 25%, transparent 25%),
                linear-gradient(-45deg, #c4c4c4 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, #c4c4c4 75%),
                linear-gradient(-45deg, transparent 75%, #c4c4c4 75%);
            background-size: 20px 20px;
            background-position: 0 0, 0 10px, 10px -10px, -10px 0;
        }
        canvas#image {
            position: absolute;
            left: 0;
            top: 0;
            transform-origin: 0 0;
            image-rendering: auto;
        }
        .scrollbar {
            position: absolute;
            background: rgba(0, 0, 0, 0.78);
            border: 1px solid rgba(255, 255, 255, 0.38);
            border-radius: 999px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 220ms ease-out;
        }
        .scrollbar.show.active {
            opacity: 1;
        }
        .scrollbar.left {
            left: 8px;
            top: 8px;
            bottom: 22px;
            width: 8px;
        }
        .scrollbar.bottom {
            left: 22px;
            right: 8px;
            bottom: 8px;
            height: 8px;
        }
        .scrollbar-thumb {
            position: absolute;
            background: rgba(255, 255, 255, 0.92);
            border-radius: 999px;
        }
        .scrollbar.left .scrollbar-thumb {
            left: 0;
            width: 100%;
        }
        .scrollbar.bottom .scrollbar-thumb {
            top: 0;
            height: 100%;
        }
    </style>
</head>
<body>
    <div class="viewer-root">
        <div class="toolbar">
            <span class="title">${this.escapeHtml(filename)}</span>
            <label class="control"><input type="checkbox" id="useAlpha"> Alpha</label>
            <button id="saveDefaults">Save Defaults</button>
            <span class="status" id="status">Loading...</span>
        </div>
        <div class="content">
            <div class="image-container" id="container">
                <canvas id="image"></canvas>
                <div class="scrollbar left" id="scrollbarLeft">
                    <div class="scrollbar-thumb" id="scrollbarLeftThumb"></div>
                </div>
                <div class="scrollbar bottom" id="scrollbarBottom">
                    <div class="scrollbar-thumb" id="scrollbarBottomThumb"></div>
                </div>
            </div>
        </div>
    </div>
    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const initialOptions = ${initialOptionsJson};
            const imageSrc = ${imageSrcJson};

            const container = document.getElementById("container");
            const imageCanvas = document.getElementById("image");
            const status = document.getElementById("status");
            const useAlphaInput = document.getElementById("useAlpha");
            const saveDefaultsButton = document.getElementById("saveDefaults");
            const scrollbarLeft = document.getElementById("scrollbarLeft");
            const scrollbarLeftThumb = document.getElementById("scrollbarLeftThumb");
            const scrollbarBottom = document.getElementById("scrollbarBottom");
            const scrollbarBottomThumb = document.getElementById("scrollbarBottomThumb");

            const imageCtx = imageCanvas.getContext("2d");
            const sourceCanvas = document.createElement("canvas");
            const sourceCtx = sourceCanvas.getContext("2d");
            const sourceImage = new Image();

            let scale = 1;
            let translateX = 0;
            let translateY = 0;
            let hasImage = false;
            let scrollbarFadeTimeout = null;
            let useAlpha = initialOptions.useAlpha !== false;

            function setStatus(text, isError) {
                status.textContent = text;
                status.classList.toggle("error", !!isError);
            }

            function getOptions() {
                return { useAlpha: !!useAlphaInput.checked };
            }

            function setOptions(options) {
                useAlphaInput.checked = options.useAlpha !== false;
                useAlpha = useAlphaInput.checked;
            }

            function getImageBaseSize() {
                return {
                    baseWidth: Math.max(imageCanvas.width || 1, 1),
                    baseHeight: Math.max(imageCanvas.height || 1, 1),
                };
            }

            function fitAndCenterImage() {
                const containerWidth = container.clientWidth;
                const containerHeight = container.clientHeight;
                const sizes = getImageBaseSize();
                const scaleX = containerWidth / sizes.baseWidth;
                const scaleY = containerHeight / sizes.baseHeight;
                scale = Math.min(scaleX, scaleY, 1);
                translateX = (containerWidth - sizes.baseWidth * scale) / 2;
                translateY = (containerHeight - sizes.baseHeight * scale) / 2;
                updateTransform();
            }

            function constrainBounds() {
                if (!hasImage) {
                    return;
                }

                const containerWidth = container.clientWidth;
                const containerHeight = container.clientHeight;
                const sizes = getImageBaseSize();
                const imageWidth = sizes.baseWidth * scale;
                const imageHeight = sizes.baseHeight * scale;

                if (imageWidth <= containerWidth) {
                    translateX = (containerWidth - imageWidth) / 2;
                } else {
                    const maxTranslateX = 0;
                    const minTranslateX = containerWidth - imageWidth;
                    translateX = Math.max(minTranslateX, Math.min(maxTranslateX, translateX));
                }

                if (imageHeight <= containerHeight) {
                    translateY = (containerHeight - imageHeight) / 2;
                } else {
                    const maxTranslateY = 0;
                    const minTranslateY = containerHeight - imageHeight;
                    translateY = Math.max(minTranslateY, Math.min(maxTranslateY, translateY));
                }
            }

            function updateScrollIndicators() {
                if (!hasImage) {
                    scrollbarLeft.classList.remove("show", "active");
                    scrollbarBottom.classList.remove("show", "active");
                    return;
                }

                const containerWidth = container.clientWidth;
                const containerHeight = container.clientHeight;
                const sizes = getImageBaseSize();
                const imageWidth = sizes.baseWidth * scale;
                const imageHeight = sizes.baseHeight * scale;

                if (imageHeight > containerHeight) {
                    const trackHeight = scrollbarLeft.clientHeight;
                    const visibleRatioY = containerHeight / imageHeight;
                    const thumbHeight = Math.max(16, trackHeight * visibleRatioY);
                    const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
                    const scrollRangeY = imageHeight - containerHeight;
                    const scrollRatioY = scrollRangeY > 0 ? -translateY / scrollRangeY : 0;
                    const thumbTop = maxThumbTop * Math.min(Math.max(scrollRatioY, 0), 1);
                    scrollbarLeftThumb.style.height = thumbHeight + "px";
                    scrollbarLeftThumb.style.top = thumbTop + "px";
                    scrollbarLeft.classList.add("show");
                } else {
                    scrollbarLeft.classList.remove("show", "active");
                }

                if (imageWidth > containerWidth) {
                    const trackWidth = scrollbarBottom.clientWidth;
                    const visibleRatioX = containerWidth / imageWidth;
                    const thumbWidth = Math.max(16, trackWidth * visibleRatioX);
                    const maxThumbLeft = Math.max(trackWidth - thumbWidth, 0);
                    const scrollRangeX = imageWidth - containerWidth;
                    const scrollRatioX = scrollRangeX > 0 ? -translateX / scrollRangeX : 0;
                    const thumbLeft = maxThumbLeft * Math.min(Math.max(scrollRatioX, 0), 1);
                    scrollbarBottomThumb.style.width = thumbWidth + "px";
                    scrollbarBottomThumb.style.left = thumbLeft + "px";
                    scrollbarBottom.classList.add("show");
                } else {
                    scrollbarBottom.classList.remove("show", "active");
                }

                const hasAnyScrollbar =
                    scrollbarLeft.classList.contains("show") || scrollbarBottom.classList.contains("show");
                if (hasAnyScrollbar) {
                    scrollbarLeft.classList.add("active");
                    scrollbarBottom.classList.add("active");
                    if (scrollbarFadeTimeout !== null) {
                        clearTimeout(scrollbarFadeTimeout);
                    }
                    scrollbarFadeTimeout = setTimeout(function() {
                        scrollbarLeft.classList.remove("active");
                        scrollbarBottom.classList.remove("active");
                        scrollbarFadeTimeout = null;
                    }, 900);
                }
            }

            function updateTransform() {
                constrainBounds();
                imageCanvas.style.left = translateX + "px";
                imageCanvas.style.top = translateY + "px";
                imageCanvas.style.transform = "scale(" + scale + ")";
                updateScrollIndicators();
            }

            function renderToDisplay() {
                if (!sourceCtx || !imageCtx) {
                    setStatus("Canvas context unavailable", true);
                    return;
                }

                const width = sourceCanvas.width;
                const height = sourceCanvas.height;
                imageCanvas.width = width;
                imageCanvas.height = height;

                if (useAlpha) {
                    imageCtx.clearRect(0, 0, width, height);
                    imageCtx.drawImage(sourceCanvas, 0, 0);
                } else {
                    const imgData = sourceCtx.getImageData(0, 0, width, height);
                    const data = imgData.data;
                    for (let i = 3; i < data.length; i += 4) {
                        data[i] = 255;
                    }
                    imageCtx.putImageData(imgData, 0, 0);
                }

                if (!hasImage) {
                    hasImage = true;
                    fitAndCenterImage();
                } else {
                    updateTransform();
                }
                setStatus("Ready", false);
            }

            function loadImage() {
                sourceImage.onload = function() {
                    if (!sourceCtx) {
                        setStatus("Canvas context unavailable", true);
                        return;
                    }
                    sourceCanvas.width = sourceImage.naturalWidth;
                    sourceCanvas.height = sourceImage.naturalHeight;
                    sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                    sourceCtx.drawImage(sourceImage, 0, 0);
                    renderToDisplay();
                };
                sourceImage.onerror = function() {
                    setStatus("Failed to load PNG", true);
                };
                sourceImage.src = imageSrc;
            }

            setOptions(initialOptions);
            setStatus("Loading...", false);
            loadImage();

            useAlphaInput.addEventListener("change", function() {
                useAlpha = useAlphaInput.checked;
                if (hasImage) {
                    renderToDisplay();
                }
            });

            saveDefaultsButton.addEventListener("click", function() {
                vscode.postMessage({ type: "saveDefaults", options: getOptions() });
            });

            window.addEventListener("message", function(event) {
                const message = event.data;
                if (message && message.type === "defaultsSaved") {
                    setStatus("Defaults saved", false);
                }
            });

            container.addEventListener("wheel", function(e) {
                if (!hasImage) {
                    return;
                }
                e.preventDefault();

                if (e.metaKey || e.ctrlKey) {
                    const rect = container.getBoundingClientRect();
                    const mouseX = e.clientX - rect.left;
                    const mouseY = e.clientY - rect.top;
                    const imageX = (mouseX - translateX) / scale;
                    const imageY = (mouseY - translateY) / scale;
                    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                    const newScale = scale * zoomFactor;
                    if (newScale >= 0.1 && newScale <= 20) {
                        scale = newScale;
                        translateX = mouseX - imageX * scale;
                        translateY = mouseY - imageY * scale;
                        updateTransform();
                    }
                } else {
                    const panSpeed = 1.5;
                    translateX -= e.deltaX * panSpeed;
                    translateY -= e.deltaY * panSpeed;
                    updateTransform();
                }
            }, { passive: false });

            window.addEventListener("resize", function() {
                if (hasImage) {
                    updateTransform();
                }
            });
        })();
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        const map: Record<string, string> = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "\"": "&quot;",
            "'": "&#039;",
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }
}
