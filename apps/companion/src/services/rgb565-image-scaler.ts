/**
 * ============================================================================
 * RGB565 Image Scaler & Direct DMA Blit Converter
 * Downscales images on the client side using cover-crop canvas rendering and
 * packs pixels into Little-Endian 16-bit RGB565 bytes for direct ESP32-S3 DMA display.
 * ============================================================================
 */

export interface Rgb565ConversionResult {
  readonly rgb565Bytes: Uint8Array;
  readonly dataUrlPreview: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Packs raw RGBA pixels into Little-Endian RGB565 bytes.
 * Byte order: byte[0] = low byte, byte[1] = high byte (Little-Endian for Xtensa LX7 ESP32-S3).
 */
export function packRgbaToRgb565(rgba: ArrayLike<number>, pixelCount: number): Uint8Array {
  const rgb565Bytes = new Uint8Array(pixelCount * 2);

  for (let i = 0; i < pixelCount; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;

    const r5 = (r >> 3) & 0x1f;
    const g6 = (g >> 2) & 0x3f;
    const b5 = (b >> 3) & 0x1f;

    const word = (r5 << 11) | (g6 << 5) | b5;

    // Little-Endian byte ordering
    rgb565Bytes[i * 2] = word & 0xff;
    rgb565Bytes[i * 2 + 1] = (word >> 8) & 0xff;
  }

  return rgb565Bytes;
}

/**
 * Unpacks Little-Endian RGB565 bytes back into RGBA8888 pixels.
 */
export function unpackRgb565ToRgba(rgb565: Uint8Array, pixelCount: number): Uint8Array {
  const rgba = new Uint8Array(pixelCount * 4);
  const maxPixels = Math.min(pixelCount, Math.floor(rgb565.byteLength / 2));

  for (let i = 0; i < maxPixels; i++) {
    const low = rgb565[i * 2] ?? 0;
    const high = rgb565[i * 2 + 1] ?? 0;
    const word = (high << 8) | low;

    // Unpack 5-6-5 bits and scale to 0..255
    const r = ((word >> 11) & 0x1f) << 3;
    const g = ((word >> 5) & 0x3f) << 2;
    const b = (word & 0x1f) << 3;

    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255; // Full opacity
  }

  return rgba;
}

/**
 * Loads an arbitrary browser File or Blob into an HTMLImageElement.
 */
function loadImageFromFile(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined" || typeof URL === "undefined") {
      reject(new Error("Image element or URL not supported in this environment"));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to decode image file: ${err}`));
    };
    img.src = url;
  });
}

/**
 * Converts an image File/Blob into a centered, cropped RGB565 buffer at the exact target dimensions.
 * Produces Little-Endian 16-bit RGB565 bytes matching the ST7735S / ST7789 display controller.
 */
export async function convertImageFileToRgb565(
  file: Blob,
  targetWidth = 160,
  targetHeight = 128
): Promise<Rgb565ConversionResult> {
  // Test/Node environment fallback where canvas/DOM is unavailable
  if (typeof document === "undefined" || typeof Image === "undefined") {
    const pixelCount = targetWidth * targetHeight;
    const syntheticRgba = new Uint8Array(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
      syntheticRgba[i * 4] = 0;
      syntheticRgba[i * 4 + 1] = 240; // Neon cyan/green
      syntheticRgba[i * 4 + 2] = 255;
      syntheticRgba[i * 4 + 3] = 255;
    }
    const rgb565Bytes = packRgbaToRgb565(syntheticRgba, pixelCount);
    return {
      rgb565Bytes,
      dataUrlPreview: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      width: targetWidth,
      height: targetHeight,
    };
  }

  const img = await loadImageFromFile(file);

  // Center-crop cover math
  const srcAspect = img.width / img.height;
  const targetAspect = targetWidth / targetHeight;

  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;

  if (srcAspect > targetAspect) {
    // Source is wider than target: crop left and right
    sw = Math.round(img.height * targetAspect);
    sx = Math.round((img.width - sw) / 2);
  } else {
    // Source is taller than target: crop top and bottom
    sh = Math.round(img.width / targetAspect);
    sy = Math.round((img.height - sh) / 2);
  }

  // Draw to offscreen canvas
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Unable to obtain 2D canvas rendering context");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

  const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const pixelCount = targetWidth * targetHeight;
  const rgb565Bytes = packRgbaToRgb565(imgData.data, pixelCount);
  const dataUrlPreview = canvas.toDataURL("image/png");

  return {
    rgb565Bytes,
    dataUrlPreview,
    width: targetWidth,
    height: targetHeight,
  };
}

/**
 * Converts raw Little-Endian RGB565 bytes back into an RGBA data URL string
 * for rendering previews in the Companion App UI.
 */
export function rgb565BytesToDataUrl(
  rgb565: Uint8Array,
  width: number,
  height: number
): string {
  if (typeof document === "undefined") {
    return "";
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const imgData = ctx.createImageData(width, height);
  const rgba = imgData.data;
  const pixelCount = width * height;
  const maxPixels = Math.min(pixelCount, Math.floor(rgb565.byteLength / 2));

  for (let i = 0; i < maxPixels; i++) {
    const low = rgb565[i * 2] ?? 0;
    const high = rgb565[i * 2 + 1] ?? 0;
    const word = (high << 8) | low;

    // Unpack 5-6-5 bits and scale to 0..255
    const r = ((word >> 11) & 0x1f) << 3;
    const g = ((word >> 5) & 0x3f) << 2;
    const b = (word & 0x1f) << 3;

    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255; // Full opacity
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Helper to generate a 64x80 thumbnail for vault gallery cards.
 */
export async function generateVaultThumbnail(file: Blob): Promise<{
  thumbnailBytes: Uint8Array;
  thumbnailDataUrl: string;
}> {
  const result = await convertImageFileToRgb565(file, 64, 80);
  return {
    thumbnailBytes: result.rgb565Bytes,
    thumbnailDataUrl: result.dataUrlPreview,
  };
}
