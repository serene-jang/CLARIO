interface GoogleApi {
  accounts: {
    id: {
      initialize(options: {
        client_id: string;
        nonce: string;
        auto_select: boolean;
        callback: (result: { credential: string }) => void;
      }): void;
      renderButton(element: HTMLElement, options: { type: string; text: string }): void;
      disableAutoSelect(): void;
      cancel(): void;
    };
  };
}
declare global {
  interface Window {
    google?: GoogleApi;
  }
}

let googleScript: Promise<GoogleApi> | undefined;
export function loadGoogle() {
  if (window.google) return Promise.resolve(window.google);
  if (!googleScript) {
    googleScript = new Promise<GoogleApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      const timeout = window.setTimeout(() => {
        script.remove();
        reject(new Error('Google 로그인 연결 시간이 초과되었습니다.'));
      }, 15000);
      script.onload = () => {
        window.clearTimeout(timeout);
        if (window.google) resolve(window.google);
        else reject(new Error('Google 로그인 도구를 불러오지 못했습니다.'));
      };
      script.onerror = () => {
        window.clearTimeout(timeout);
        script.remove();
        reject(new Error('Google 로그인 연결에 실패했습니다. 네트워크를 확인해 주세요.'));
      };
      document.head.append(script);
    }).catch((cause: unknown) => {
      googleScript = undefined;
      throw cause;
    });
  }
  return googleScript;
}
