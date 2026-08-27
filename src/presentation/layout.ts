/** Shared text layout so views stay declarative and free of padding arithmetic. */

const RULE_WIDTH = 100;

export const column = (value: string | number, width: number): string => {
  const text = String(value);
  return text.length >= width ? `${text} ` : text + ' '.repeat(width - text.length);
};

export const heading = (labels: readonly string[], widths: readonly number[]): string =>
  labels
    .map((label, index) => {
      const width = widths[index];
      return width === undefined ? label : column(label, width);
    })
    .join('');

export const rule = (width: number = RULE_WIDTH): string => '-'.repeat(width);

export const blank = (): string => '';

export const indent = (text: string, depth = 1): string => '  '.repeat(depth) + text;

export const section = (title: string, count: number): string => `${title} (${count})`;

export const emptyNotice = (message = 'none'): string => indent(message);
