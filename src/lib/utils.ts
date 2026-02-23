export function isTMA() {
  return !!window.Telegram.WebView.initParams.tgWebAppData;
}

export const tgToken = window.Telegram.WebView.initParams.tgWebAppData;
