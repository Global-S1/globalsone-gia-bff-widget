import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Fija BFF_JWT_SECRET antes de que la configuración lo lea al importarse.
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.types.ts", "src/types/**", "src/**/__tests__/**", "src/test/**"],
      // Umbral MEDIDO el 2026-08-14, no elegido (RNF-001). Este repositorio
      // partía de CERO pruebas —y de hecho ni siquiera podía instalarse—, así
      // que el número es muy bajo, y eso es lo correcto: lo que el umbral
      // impide es la regresión, no la falta de cobertura.
      thresholds: {
        lines: 8.06,
      },
    },
  },
});
