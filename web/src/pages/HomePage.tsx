import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ServiceSummary } from '@shared/types';
import { TopBar } from '../components/TopBar';
import { api } from '../lib/api';
import { cameraColor } from '../lib/format';
import { QrCode } from '../components/QrCode';

export function HomePage() {
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [apk, setApk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const reload = () => api.listServices().then(setServices).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => {
    reload();
    api
      .info()
      .then((i) => {
        setLanUrls(i.lanUrls);
        setApk(i.apk);
      })
      .catch(() => {});
  }, []);

  const goLive = async (id: string) => {
    try {
      await api.loadShow(id);
      navigate('/director');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const create = async () => {
    const title = prompt('행사 이름', '새 행사');
    if (!title) return;
    const today = new Date().toISOString().slice(0, 10);
    const s = await api.createService(title, today).catch((e) => (setError(e.message), null));
    if (s) navigate(`/editor/${s.id}`);
  };

  const importFile = async (file: File) => {
    try {
      const s = await api.importService(JSON.parse(await file.text()));
      await reload();
      navigate(`/editor/${s.id}`);
    } catch (e) {
      setError(`가져오기 실패: ${(e as Error).message}`);
    }
  };

  const origin = lanUrls[0] ?? location.origin;

  return (
    <>
      <TopBar />
      <main className="home">
        {error && (
          <p className="badge" style={{ borderColor: 'var(--pgm)' }} onClick={() => setError(null)}>
            ⚠️ {error}
          </p>
        )}
        <section>
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>행사 큐시트</h2>
            <div className="spacer" />
            <button onClick={() => fileRef.current?.click()}>JSON 가져오기</button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importFile(f);
                e.target.value = '';
              }}
            />
            <button className="primary" onClick={create}>
              + 새 행사
            </button>
          </div>
          <table>
            <thead>
              <tr className="muted">
                <th>날짜</th>
                <th>행사</th>
                <th>순서/큐</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.date ?? '-'}</td>
                  <td>{s.title}</td>
                  <td className="muted">
                    {s.actCount} / {s.cueCount}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <Link to={`/editor/${s.id}`}>편집</Link>
                      <button className="primary" onClick={() => goLive(s.id)}>
                        라이브로 열기
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {services.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    행사가 없습니다. <code>npm run db:seed</code> 로 샘플을 넣거나 새 행사를 만드세요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section>
          <h2>📱 카메라맨 폰 연결</h2>
          <div className="phone-connect">
            <div>
              <h3>안드로이드 — CamCue 앱 (권장)</h3>
              {apk ? (
                <>
                  <ol>
                    <li>폰 카메라로 QR 을 찍어 앱을 내려받아 설치 (처음 한 번)</li>
                    <li>앱 실행 → 같은 Wi-Fi 의 이 PC 를 <b>자동으로 찾아</b> 접속</li>
                    <li>카메라 번호를 고르면 끝 — 화면 꺼짐 방지·진동 자동</li>
                  </ol>
                  <QrCode url={`${origin}/app`} />
                  <div className="muted mono" style={{ fontSize: 12 }}>
                    {origin}/app
                  </div>
                </>
              ) : (
                <p className="muted">
                  이 실행본에는 앱 설치 파일이 없습니다. GitHub Releases 의 <span className="mono">CamCue-Android-*.apk</span> 를 받아 설치하세요.
                </p>
              )}
            </div>
            <div>
              <h3>아이폰 · 기타 — 브라우저</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                같은 Wi-Fi 에서 아래 주소로 접속 (Safari 공유 → <b>홈 화면에 추가</b> 하면 앱처럼 실행)
              </p>
              <p className="mono">{origin}/cam/번호</p>
            </div>
          </div>
          <div className="cam-links">
            {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
              <a key={n} href={`/cam/${n}`} style={{ borderLeft: `6px solid ${cameraColor(n)}` }}>
                CAM {n}
                <div className="muted mono" style={{ fontSize: 11, fontWeight: 400 }}>
                  {origin.replace(/^https?:\/\//, '')}/cam/{n}
                </div>
              </a>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
