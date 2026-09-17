import type { HermesAccess } from 'librechat-data-provider';
const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export async function inlineImage(file: File, connection: HermesAccess): Promise<string> {
  if (file.size <= connection.maxInlineImageBytes) {
    return readFile(file);
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const ratio = Math.min(1, connection.imageMaxDimension / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('image_conversion_unavailable');
    }
    for (;;) {
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', 0.85);
      if (data.length * 0.75 <= connection.maxInlineImageBytes) {
        return data;
      }
      if (canvas.width <= 1 && canvas.height <= 1) {
        throw new Error('image_limit_too_small');
      }
      canvas.width = Math.max(1, Math.floor(canvas.width / 2));
      canvas.height = Math.max(1, Math.floor(canvas.height / 2));
    }
  } finally {
    bitmap.close();
  }
}
