// 입력 검증(zod): 에디터 저장 / JSON 가져오기 공용
import { z } from 'zod';
import { isValidAtemAction } from './atemAction';
import { ADVANCE_MODES, MAX_CAMERA, MIN_CAMERA, SECTION_PATTERN, SHOT_SIZES, type Service } from './types';

const optionalNumber = (schema: z.ZodNumber) => schema.nullable().optional().transform((v) => v ?? null);

export const cueInputSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  camera: z.number().int().min(MIN_CAMERA).max(MAX_CAMERA),
  shotSize: z.enum(SHOT_SIZES),
  note: z.string().max(500).optional().default(''),
  durationSec: optionalNumber(z.number().positive().max(86_400)),
  section: z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.string().regex(SECTION_PATTERN, '섹션은 영문 대문자로 시작하는 1~8자'))
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null))
    .transform((v) => v ?? null),
  bars: optionalNumber(z.number().positive().max(1000)),
  tcInSec: optionalNumber(z.number().min(0).max(86_400)),
  atemAction: z
    .string()
    .optional()
    .default('cut')
    .transform((s) => s.trim().toLowerCase())
    .refine(isValidAtemAction, 'atemAction 은 cut | auto | macro:n | dsk:n:on | dsk:n:off'),
});

export const actInputSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(100),
  mode: z.enum(ADVANCE_MODES).optional().default('MANUAL'),
  bpm: optionalNumber(z.number().min(20).max(400)),
  beatsPerBar: z.number().int().min(1).max(16).optional().default(4),
  cues: z.array(cueInputSchema).max(500).default([]),
});

export const serviceInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(100),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '날짜는 YYYY-MM-DD')
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  acts: z.array(actInputSchema).max(100).default([]),
});

export type ServiceInput = z.infer<typeof serviceInputSchema>;

export const EXPORT_FORMAT = 'camcue/service@1';
/** v0.0.1(Mini CuePilot) 에서 내보낸 파일도 가져올 수 있도록 허용 */
export const LEGACY_EXPORT_FORMATS = ['mini-cuepilot/service@1'] as const;

/** 내보내기 파일 형식. 가져오기는 이 래퍼 또는 서비스 객체 단독 둘 다 허용 */
export const exportFileSchema = z.object({
  format: z.enum([EXPORT_FORMAT, ...LEGACY_EXPORT_FORMATS]),
  exportedAt: z.string().optional(),
  service: serviceInputSchema,
});

export function parseImport(raw: unknown): ServiceInput {
  const wrapped = exportFileSchema.safeParse(raw);
  if (wrapped.success) return wrapped.data.service;
  return serviceInputSchema.parse(raw);
}

/** 내보내기용: id 를 제거해 다른 서버/행사로 옮겨도 충돌 없게 함 */
export function toExportFile(service: Service, exportedAt = new Date().toISOString()) {
  return {
    format: EXPORT_FORMAT,
    exportedAt,
    service: {
      title: service.title,
      date: service.date,
      acts: service.acts.map(({ id: _a, cues, ...act }) => ({
        ...act,
        cues: cues.map(({ id: _c, ...cue }) => cue),
      })),
    },
  };
}

/** 디렉터 명령 (WebSocket / REST 공용) */
export const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('GO') }),
  z.object({ command: z.literal('BACK') }),
  z.object({ command: z.literal('RESET') }),
  z.object({ command: z.literal('HOLD'), on: z.boolean().optional() }),
  z.object({ command: z.literal('JUMP'), actIndex: z.number().int(), cueIndex: z.number().int() }),
]);

export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
