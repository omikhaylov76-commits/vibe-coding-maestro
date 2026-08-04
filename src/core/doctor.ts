/**
 * Совместимый фасад: doctor разделён на модули в ./doctor/, публичный импорт не меняется.
 * Новый код может импортировать './doctor/index.js' напрямую.
 */
export { doctorProject } from './doctor/index.js';
export type { DoctorFinding, DoctorOptions, DoctorReport, FindingLevel } from './doctor/types.js';
