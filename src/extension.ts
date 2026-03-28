import * as fs from "fs";
import * as path from "path";
import { PNG } from "pngjs";
import * as vscode from "vscode";

const VIEW_TYPE = "pngViewer.png";
const ALPHA_OPTIONS_STORAGE_KEY = "pngViewer.alphaOptions";
const IMAGE_TRANSFER_CHUNK_SIZE = 256 * 1024;

type AlphaOptions = {
    useAlpha: boolean;
};

const DEFAULT_ALPHA_OPTIONS: AlphaOptions = {
    useAlpha: true,
};

type RawPngData = {
    width: number;
    height: number;
    style: "L" | "RGB" | "RGBA";
    rgbaBytes: Uint8Array;
};

export function activate(context: vscode.ExtensionContext): void {
    const provider = new PngEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
            supportsMultipleEditorsPerDocument: true,
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
        const currentOptions = this.getSavedOptions();
        const fileStats = await fs.promises.stat(document.uri.fsPath);
        let rawPngData: RawPngData;
        try {
            rawPngData = await this.loadPngData(document.uri.fsPath);
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : "Failed to decode PNG file.";
            webviewPanel.webview.html = this.getErrorHtml(errorMessage);
            return;
        }

        webviewPanel.webview.options = {
            enableScripts: true,
        };
        webviewPanel.webview.html = this.getViewerHtml(
            path.basename(document.uri.fsPath),
            `WxH ${rawPngData.width}x${rawPngData.height} • ${rawPngData.style} • ${this.formatFileSize(fileStats.size)}`,
            currentOptions,
        );

        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (message?.type === "webviewReady") {
                const totalBytes = rawPngData.rgbaBytes.length;
                await webviewPanel.webview.postMessage({
                    type: "imageLoadStart",
                    width: rawPngData.width,
                    height: rawPngData.height,
                    totalBytes,
                });

                for (let offset = 0; offset < totalBytes; offset += IMAGE_TRANSFER_CHUNK_SIZE) {
                    const nextOffset = Math.min(offset + IMAGE_TRANSFER_CHUNK_SIZE, totalBytes);
                    await webviewPanel.webview.postMessage({
                        type: "imageLoadChunk",
                        offset,
                        chunk: rawPngData.rgbaBytes.slice(offset, nextOffset),
                    });
                }

                await webviewPanel.webview.postMessage({
                    type: "imageLoadComplete",
                });
                return;
            }

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

    private async loadPngData(filePath: string): Promise<RawPngData> {
        const inputBuffer = await fs.promises.readFile(filePath);
        const decoded = await new Promise<PNG>((resolve, reject) => {
            const parser = new PNG();
            parser.parse(inputBuffer, (error, data) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(data);
            });
        });
        return {
            width: decoded.width,
            height: decoded.height,
            style: this.getDisplayStyle(decoded as PNG & { colorType?: number }),
            rgbaBytes: Uint8Array.from(decoded.data),
        };
    }

    private getDisplayStyle(decoded: PNG & { colorType?: number }): "L" | "RGB" | "RGBA" {
        if (decoded.colorType === 0) {
            return "L";
        }
        if (decoded.colorType === 2) {
            return "RGB";
        }
        return "RGBA";
    }

    private formatFileSize(bytes: number): string {
        const KB = 1000;
        const MB = KB * 1000;
        const GB = MB * 1000;

        if (bytes >= GB) {
            return `${(bytes / GB).toFixed(1)} GB`;
        }
        if (bytes >= MB) {
            return `${(bytes / MB).toFixed(1)} MB`;
        }
        return `${(bytes / KB).toFixed(1)} KB`;
    }

    private getViewerHtml(filename: string, imageInfo: string, initialOptions: AlphaOptions): string {
        const initialOptionsJson = JSON.stringify(initialOptions);
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
        .meta {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            white-space: nowrap;
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
            background-color: var(--vscode-editor-background);
        }
        canvas#image {
            position: absolute;
            left: 0;
            top: 0;
            transform-origin: 0 0;
            image-rendering: auto;
            will-change: transform, left, top;
            background-color: #232629;
            background-image:
                linear-gradient(45deg, #2f3337 25%, transparent 25%),
                linear-gradient(-45deg, #2f3337 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, #2f3337 75%),
                linear-gradient(-45deg, transparent 75%, #2f3337 75%);
            background-size: 16px 16px;
            background-position: 0 0, 0 8px, 8px -8px, -8px 0;
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
            <label class="control"><input type="checkbox" id="useAlpha"> Alpha</label>
            <span class="meta">${this.escapeHtml(imageInfo)}</span>
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
            let scale = 1;
            let translateX = 0;
            let translateY = 0;
            let hasImage = false;
            let scrollbarFadeTimeout = null;
            let sourcePixels = null;
            let sourceImageData = null;
            let opaqueImageData = null;
            let sourceWidth = 0;
            let sourceHeight = 0;
            let expectedBytes = 0;
            let receivedBytes = 0;
            let hostResponseTimeout = null;

            function setStatus(text, isError) {
                status.textContent = text;
                status.classList.toggle("error", !!isError);
            }

            function getOptions() {
                return { useAlpha: !!useAlphaInput.checked };
            }

            function setOptions(options) {
                useAlphaInput.checked = options.useAlpha !== false;
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

            function toUint8ClampedArray(value) {
                if (value instanceof Uint8Array) {
                    return new Uint8ClampedArray(value);
                }
                if (value instanceof Uint8ClampedArray) {
                    return new Uint8ClampedArray(value);
                }
                if (value instanceof ArrayBuffer) {
                    return new Uint8ClampedArray(value);
                }
                if (Array.isArray(value)) {
                    return new Uint8ClampedArray(value);
                }
                if (
                    value &&
                    typeof value === "object" &&
                    value.type === "Buffer" &&
                    Array.isArray(value.data)
                ) {
                    return new Uint8ClampedArray(value.data);
                }
                if (value && typeof value === "object" && Array.isArray(value.data)) {
                    return new Uint8ClampedArray(value.data);
                }
                return null;
            }

            function renderToDisplay() {
                if (!imageCtx) {
                    setStatus("Canvas context unavailable", true);
                    return;
                }
                if (!sourcePixels) {
                    setStatus("Waiting for image data...", false);
                    return;
                }

                const width = sourceWidth;
                const height = sourceHeight;
                imageCanvas.width = width;
                imageCanvas.height = height;

                if (!sourceImageData) {
                    sourceImageData = new ImageData(sourcePixels, width, height);
                }
                if (!useAlphaInput.checked && !opaqueImageData) {
                    const opaquePixels = new Uint8ClampedArray(sourcePixels);
                    for (let i = 3; i < opaquePixels.length; i += 4) {
                        opaquePixels[i] = 255;
                    }
                    opaqueImageData = new ImageData(opaquePixels, width, height);
                }

                imageCtx.putImageData(useAlphaInput.checked ? sourceImageData : opaqueImageData, 0, 0);

                if (!hasImage) {
                    hasImage = true;
                    fitAndCenterImage();
                } else {
                    updateTransform();
                }
                setStatus("Ready", false);
            }

            setOptions(initialOptions);
            setStatus("Loading...", false);
            hostResponseTimeout = setTimeout(function() {
                if (!sourcePixels) {
                    setStatus("No response from extension host", true);
                }
            }, 5000);
            vscode.postMessage({ type: "webviewReady" });

            useAlphaInput.addEventListener("change", function() {
                if (hasImage) {
                    renderToDisplay();
                }
            });

            saveDefaultsButton.addEventListener("click", function() {
                vscode.postMessage({ type: "saveDefaults", options: getOptions() });
            });

            window.addEventListener("message", function(event) {
                const message = event.data;
                if (message && message.type === "imageLoadStart") {
                    if (hostResponseTimeout !== null) {
                        clearTimeout(hostResponseTimeout);
                        hostResponseTimeout = null;
                    }
                    sourceWidth = Number(message.width) || 0;
                    sourceHeight = Number(message.height) || 0;
                    expectedBytes = Number(message.totalBytes) || 0;
                    receivedBytes = 0;

                    if (!sourceWidth || !sourceHeight || !expectedBytes) {
                        setStatus("Invalid PNG image data", true);
                        return;
                    }

                    sourcePixels = new Uint8ClampedArray(expectedBytes);
                    sourceImageData = null;
                    opaqueImageData = null;
                    setStatus("Loading image data...", false);
                    return;
                }

                if (message && message.type === "imageLoadChunk") {
                    if (!sourcePixels || !(sourcePixels instanceof Uint8ClampedArray)) {
                        setStatus("Invalid PNG image data", true);
                        return;
                    }
                    const offset = Number(message.offset) || 0;
                    const chunk = toUint8ClampedArray(message.chunk);
                    if (!chunk || offset < 0 || offset + chunk.length > sourcePixels.length) {
                        setStatus("Invalid PNG image data", true);
                        return;
                    }
                    sourcePixels.set(chunk, offset);
                    receivedBytes += chunk.length;
                    const progress = Math.min(100, Math.round((receivedBytes / Math.max(expectedBytes, 1)) * 100));
                    setStatus("Loading image data... " + progress + "%", false);
                    return;
                }

                if (message && message.type === "imageLoadComplete") {
                    const expectedSize = sourceWidth * sourceHeight * 4;
                    if (
                        !sourcePixels ||
                        !(sourcePixels instanceof Uint8ClampedArray) ||
                        sourcePixels.length !== expectedBytes ||
                        expectedBytes !== expectedSize ||
                        receivedBytes < expectedBytes
                    ) {
                        setStatus("Invalid PNG image data", true);
                        return;
                    }
                    renderToDisplay();
                    return;
                }
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

                    // Delta-aware exponential zoom is much smoother for high-resolution
                    // trackpad gesture streams (especially on large images).
                    const zoomIntensity = 0.006;
                    const zoomFactor = Math.exp(-e.deltaY * zoomIntensity);
                    const targetScale = scale * zoomFactor;
                    const newScale = Math.min(20, Math.max(0.1, targetScale));
                    if (newScale === scale) {
                        return;
                    }

                    scale = newScale;
                    translateX = mouseX - imageX * scale;
                    translateY = mouseY - imageY * scale;
                    updateTransform();
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

    private getErrorHtml(errorMessage: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PNG Viewer - Error</title>
    <style>
        body {
            margin: 0;
            padding: 32px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
        }
        .error {
            max-width: 860px;
            margin: 0 auto;
            padding: 18px;
            border-radius: 6px;
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            background: var(--vscode-inputValidation-errorBackground);
        }
        h2 {
            margin-top: 0;
            color: var(--vscode-errorForeground);
        }
        pre {
            margin: 0;
            white-space: pre-wrap;
            word-break: break-word;
            background: var(--vscode-textCodeBlock-background);
            padding: 10px;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="error">
        <h2>Failed to Load PNG</h2>
        <pre>${this.escapeHtml(errorMessage)}</pre>
    </div>
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
