// Лазерная рулетка FNIRSI (IR40 / модели fnirsi.etool.40*).
// Протокол взят из открытых проектов fnirsi-ir40-cad-bridge и ir40-dbus-final.
export const RULER = {
  namePrefix: "fnirsi",
  service: "0000ee01-0000-1000-8000-00805f9b34fb",
  notify: "0000ee02-0000-1000-8000-00805f9b34fb",
  write: "0000ee03-0000-1000-8000-00805f9b34fb",
  start: new Uint8Array([0x00, 0x07, 0x02, 0x08, 0x0e, 0x00, 0x00, 0x00, 0x01]),
  stop: new Uint8Array([0x00, 0x07, 0x02, 0x08, 0x0e, 0x00, 0x00, 0x00, 0x00]),
  ping: new Uint8Array([0x00, 0x01, 0x02]),
};

// Возвращает расстояние в миллиметрах или null (служебный пакет)
export function parseRulerMm(bytes) {
  if (bytes.length < 16 || bytes[0] !== 0x00 || bytes[2] !== 0x02) return null;
  const mm = (bytes[14] << 8) | bytes[15];
  return mm > 50 ? mm : null;
}
