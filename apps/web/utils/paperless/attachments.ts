const supportedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/bmp",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

export function isPaperlessAttachment(attachment: {
  mimeType: string;
  filename: string;
}) {
  return (
    supportedMimeTypes.has(attachment.mimeType.toLowerCase()) ||
    (attachment.mimeType === "application/octet-stream" &&
      /\.(pdf|jpe?g|png|tiff?|webp|bmp|txt|csv|docx?|xlsx?|pptx?|odt|ods)$/i.test(
        attachment.filename,
      ))
  );
}
