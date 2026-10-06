import { DisabledAtemAdapter, type AtemAdapter } from './types';

export * from './types';

/** ATEM_HOST 값에 따라 어댑터 선택 (실제 장비/mock 은 7단계에서 추가) */
export function createAtemAdapter(_host: string | undefined): AtemAdapter {
  return new DisabledAtemAdapter();
}
