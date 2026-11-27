import type { TextRanges } from '@app/contracts/dto';

export type PdfTransform = [number, number, number, number, number, number];
export type PdfViewBox = [number, number, number, number];

export interface RawPdfTextItem {
  str: string;
  transform: PdfTransform;
  width: number;
  height: number;
  dir?: string;
  hasEOL?: boolean;
}

export interface RawPdfPage {
  pageNumber: number;
  view: PdfViewBox;
  items: RawPdfTextItem[];
}

export type HiddenRange = TextRanges['hidden'][number];
export type LowVisibilityRange = TextRanges['lowVisibility'][number];

const ROTATION_THRESHOLD_RAD = (5 * Math.PI) / 180;
export const LOW_VISIBILITY_FONT_PT = 1.5;

/**
 * Effective font size in PDF user-space points derived from the 2x2 linear part of the text transform.
 */
export function effectiveFontSize(item: RawPdfTextItem): number {
  const [a, b, c, d] = item.transform;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  const maxScale = Math.max(sx, sy);
  if (maxScale > 0) {
    return maxScale;
  }
  return Math.abs(item.height);
}

/**
 * Returns true if the text baseline deviates more than 5 degrees from horizontal left-to-right.
 */
export function isRotatedItem(item: RawPdfTextItem): boolean {
  const [a, b] = item.transform;
  if (Math.hypot(a, b) <= 1e-6) {
    return false;
  }
  const angle = Math.atan2(b, a);
  return Math.abs(angle) > ROTATION_THRESHOLD_RAD;
}

/**
 * Returns true when an item's bounding box lies completely outside the page view box (spec §5.1 OFF_PAGE).
 */
export function isOffPageItem(item: RawPdfTextItem, view: PdfViewBox): boolean {
  const [vx0, vy0, vx1, vy1] = view;
  const minX = Math.min(vx0, vx1);
  const maxX = Math.max(vx0, vx1);
  const minY = Math.min(vy0, vy1);
  const maxY = Math.max(vy0, vy1);

  const [a, b, c, d, e, f] = item.transform;
  const w = Math.abs(item.width);
  const h = Math.abs(item.height) > 0 ? Math.abs(item.height) : effectiveFontSize(item);

  if (w === 0 && h === 0) {
    return e < minX || e > maxX || f < minY || f > maxY;
  }

  const lenA = Math.hypot(a, b);
  const ux = lenA > 1e-6 ? (a / lenA) * w : w;
  const uy = lenA > 1e-6 ? (b / lenA) * w : 0;

  const lenC = Math.hypot(c, d);
  const vx = lenC > 1e-6 ? (c / lenC) * h : 0;
  const vy = lenC > 1e-6 ? (d / lenC) * h : h;

  const xs = [e, e + ux, e + vx, e + ux + vx];
  const ys = [f, f + uy, f + vy, f + uy + vy];

  const ix0 = Math.min(...xs);
  const ix1 = Math.max(...xs);
  const iy0 = Math.min(...ys);
  const iy1 = Math.max(...ys);

  return ix1 <= minX || ix0 >= maxX || iy1 <= minY || iy0 >= maxY;
}

/**
 * Effective font size under 1.5pt is marked lowVisibility (spec §5.1).
 */
export function isLowVisibilityItem(item: RawPdfTextItem): boolean {
  const fontSize = effectiveFontSize(item);
  return fontSize > 0 && fontSize < LOW_VISIBILITY_FONT_PT;
}

export function mergeHiddenRanges(ranges: readonly HiddenRange[]): HiddenRange[] {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: HiddenRange[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end, reason] = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (reason === last[2] && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end, reason]);
    }
  }
  return merged;
}

export function mergeLowVisibilityRanges(
  ranges: readonly LowVisibilityRange[],
): LowVisibilityRange[] {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: LowVisibilityRange[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}
