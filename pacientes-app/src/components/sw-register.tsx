"use client";

import { useEffect } from "react";

export function SwRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Sem SW não é fatal — o app segue funcionando no navegador.
      });
    }
  }, []);
  return null;
}
