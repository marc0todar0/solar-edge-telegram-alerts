declare global {
  namespace NodeJS {
    interface ProcessEnv {
      TELEGRAM_TOKEN: string;
      chatID: string;
      MY_SOLAR_EDGE_SITE: string;
      SE_CLIENT_ID: string;
      SE_CLIENT_SECRET: string;
      POLLING_RATE_SEC?: string;
      ACTIVE_HOURS?: string;
      MINUTES_BEFORE_UPDATE?: string;
      DATA_DIR?: string;
    }
  }
}

export {};
