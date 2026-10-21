import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** URL → QR 코드 (폰 카메라로 찍어 바로 접속·내려받기) */
export function QrCode({ url }: { url: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [url]);
  if (!svg) return null;
  return <div className="qr" role="img" aria-label={`QR: ${url}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}
