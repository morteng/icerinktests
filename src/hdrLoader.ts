/**
 * RGBE (.hdr) file loader — parses Radiance HDR format into Float32Array RGB data.
 * Supports both uncompressed and RLE-compressed scanlines.
 */

export interface HDRImage {
  width: number;
  height: number;
  data: Float32Array; // RGB float data, 3 floats per pixel
}

function rgbeToFloat(r: number, g: number, b: number, e: number): [number, number, number] {
  if (e === 0) return [0, 0, 0];
  const scale = Math.pow(2, e - 128 - 8);
  return [r * scale, g * scale, b * scale];
}

export async function loadHDR(url: string): Promise<HDRImage> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let pos = 0;

  // Read header lines
  function readLine(): string {
    let line = '';
    while (pos < bytes.length) {
      const ch = bytes[pos++];
      if (ch === 10) break; // newline
      if (ch !== 13) line += String.fromCharCode(ch); // skip CR
    }
    return line;
  }

  // Parse header
  const magic = readLine();
  if (!magic.startsWith('#?')) {
    throw new Error('Not a valid HDR file');
  }

  let format = '';
  while (pos < bytes.length) {
    const line = readLine();
    if (line === '') break; // empty line = end of header
    if (line.startsWith('FORMAT=')) {
      format = line.substring(7);
    }
  }

  if (format && format !== '32-bit_rle_rgbe' && format !== '32-bit_rle_xyze') {
    throw new Error(`Unsupported HDR format: ${format}`);
  }

  // Parse resolution line: "-Y height +X width"
  const resLine = readLine();
  const resMatch = resLine.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
  if (!resMatch) {
    throw new Error(`Cannot parse resolution: ${resLine}`);
  }
  const height = parseInt(resMatch[1]);
  const width = parseInt(resMatch[2]);

  const data = new Float32Array(width * height * 3);

  // Read scanlines
  for (let y = 0; y < height; y++) {
    const scanline = readScanline(bytes, pos, width);
    pos = scanline.nextPos;

    for (let x = 0; x < width; x++) {
      const [fr, fg, fb] = rgbeToFloat(
        scanline.data[x * 4],
        scanline.data[x * 4 + 1],
        scanline.data[x * 4 + 2],
        scanline.data[x * 4 + 3],
      );
      const idx = (y * width + x) * 3;
      data[idx] = fr;
      data[idx + 1] = fg;
      data[idx + 2] = fb;
    }
  }

  return { width, height, data };
}

function readScanline(
  bytes: Uint8Array,
  pos: number,
  width: number,
): { data: Uint8Array; nextPos: number } {
  const scanline = new Uint8Array(width * 4);

  // Check for new-style RLE
  if (width >= 8 && width <= 0x7fff) {
    const b0 = bytes[pos];
    const b1 = bytes[pos + 1];
    const b2 = bytes[pos + 2];
    const b3 = bytes[pos + 3];

    if (b0 === 2 && b1 === 2 && ((b2 << 8) | b3) === width) {
      // New-style RLE: each component stored separately, then RLE within component
      pos += 4;
      for (let ch = 0; ch < 4; ch++) {
        let x = 0;
        while (x < width) {
          const code = bytes[pos++];
          if (code > 128) {
            // Run: repeat next byte (code - 128) times
            const count = code - 128;
            const val = bytes[pos++];
            for (let i = 0; i < count && x < width; i++) {
              scanline[x * 4 + ch] = val;
              x++;
            }
          } else {
            // Literal: copy next 'code' bytes
            for (let i = 0; i < code && x < width; i++) {
              scanline[x * 4 + ch] = bytes[pos++];
              x++;
            }
          }
        }
      }
      return { data: scanline, nextPos: pos };
    }
  }

  // Old-style: just read RGBE values directly
  for (let x = 0; x < width; x++) {
    scanline[x * 4] = bytes[pos++];
    scanline[x * 4 + 1] = bytes[pos++];
    scanline[x * 4 + 2] = bytes[pos++];
    scanline[x * 4 + 3] = bytes[pos++];
  }
  return { data: scanline, nextPos: pos };
}
