// 카메라별 종이 큐시트 (비상용). Wi-Fi·PC 에 문제가 생겨도 카메라맨이 순서를 볼 수 있도록 인쇄/PDF 로 나눠 준다.
// 카메라마다 한 장(넘치면 이어서), 맨 앞에 전체 진행표.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { cueDurationMs } from '@shared/engine';
import { parseNote } from '@shared/note';
import type { Act, Cue, Service } from '@shared/types';
import { api } from '../lib/api';
import { MODE_LABEL, SHOT_LABEL, formatClock } from '../lib/format';
import './print.css';

interface Row {
  act: Act;
  a: number;
  c: number;
  cue: Cue;
  /** 직전 큐 카메라 (누구에게서 넘겨받는지) */
  prevCam: number | null;
}

function rowsOf(service: Service): Row[] {
  const out: Row[] = [];
  let prev: number | null = null;
  service.acts.forEach((act, a) =>
    act.cues.forEach((cue, c) => {
      out.push({ act, a, c, cue, prevCam: prev });
      prev = cue.camera;
    }),
  );
  return out;
}

const lengthText = (act: Act, c: number, cue: Cue) => {
  const ms = cueDurationMs(act, c);
  if (act.mode === 'SECTION' && cue.bars != null) return `${cue.bars}마디${ms != null ? ` (${formatClock(ms)})` : ''}`;
  return ms != null ? formatClock(ms) : '수동';
};

export function PrintPage() {
  const { id } = useParams();
  const [service, setService] = useState<Service | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withAll, setWithAll] = useState(true);
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (id) api.getService(id).then(setService).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    if (service) document.title = `큐시트 인쇄 · ${service.title}`;
  }, [service]);

  if (error) return <p style={{ padding: 16 }}>{error}</p>;
  if (!service) return <p style={{ padding: 16 }}>불러오는 중…</p>;

  const rows = rowsOf(service);
  const cams = [...new Set(rows.map((r) => r.cue.camera))].sort((x, y) => x - y);
  const head = `${service.date ?? ''} ${service.title}`.trim();

  return (
    <div className="pr">
      <div className="pr-toolbar">
        <b>카메라별 큐시트</b>
        <label>
          <input type="checkbox" checked={withAll} onChange={(e) => setWithAll(e.target.checked)} /> 전체 진행표
        </label>
        {cams.map((n) => (
          <label key={n}>
            <input
              type="checkbox"
              checked={!hidden.has(n)}
              onChange={() =>
                setHidden((h) => {
                  const x = new Set(h);
                  if (x.has(n)) x.delete(n);
                  else x.add(n);
                  return x;
                })
              }
            />{' '}
            CAM {n}
          </label>
        ))}
        <button onClick={() => window.print()}>인쇄 / PDF 저장</button>
        <span className="pr-hint">카메라마다 새 페이지로 나뉩니다</span>
      </div>

      {withAll && (
        <section className="pr-page">
          <h1>
            전체 진행표 <small>{head}</small>
          </h1>
          <table>
            <thead>
              <tr>
                <th>순서</th>
                <th>#</th>
                <th>CAM</th>
                <th>샷</th>
                <th>섹션</th>
                <th>메모</th>
                <th>길이</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.cue.id} className={r.c === 0 ? 'pr-act-start' : ''}>
                  <td>{r.c === 0 ? `${r.a + 1}. ${r.act.title}` : ''}</td>
                  <td>{r.c + 1}</td>
                  <td className="pr-cam">{r.cue.camera}</td>
                  <td>{r.cue.shotSize}</td>
                  <td>{r.cue.section ?? ''}</td>
                  <td>
                    <Note note={r.cue.note} />
                  </td>
                  <td>{lengthText(r.act, r.c, r.cue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {cams
        .filter((n) => !hidden.has(n))
        .map((n) => {
          const mine = rows.filter((r) => r.cue.camera === n);
          return (
            <section key={n} className="pr-page">
              <h1>
                CAM {n} <small>{head} · 내 큐 {mine.length}개</small>
              </h1>
              <table>
                <thead>
                  <tr>
                    <th>순서</th>
                    <th>#</th>
                    <th>샷</th>
                    <th>메모</th>
                    <th>섹션 / 진행</th>
                    <th>직전 CAM</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((r) => (
                    <tr key={r.cue.id}>
                      <td>{r.act.title}</td>
                      <td>{r.c + 1}</td>
                      <td className="pr-shot">
                        {r.cue.shotSize}
                        <small>{SHOT_LABEL[r.cue.shotSize]}</small>
                      </td>
                      <td>
                        <Note note={r.cue.note} />
                      </td>
                      <td>
                        {r.cue.section ? `${r.cue.section} · ` : ''}
                        {MODE_LABEL[r.act.mode]} · {lengthText(r.act, r.c, r.cue)}
                      </td>
                      <td>{r.prevCam ?? '시작'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="pr-foot">연결이 끊기면 이 종이와 카메라 탈리 램프를 보고 진행하세요 · CamCue</p>
            </section>
          );
        })}
    </div>
  );
}

function Note({ note }: { note: string }) {
  const n = parseNote(note);
  return n.important ? <b>⚠ {n.text}</b> : <>{n.text}</>;
}
