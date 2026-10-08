// 앱 이름·버전: package.json 의 version 이 단일 기준 (서버·웹·설치 파일·릴리스 모두 이 값을 사용)
import { version } from '../../package.json';

export const APP_VERSION: string = version;
export const APP_NAME = 'CamCue';
export const APP_NAME_KO = '캠큐';
