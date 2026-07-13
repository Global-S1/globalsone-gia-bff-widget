import { request, Dispatcher } from "undici";
import {
  IServiceClient,
  IServiceConfig,
  IServiceRequestOptions,
} from "../../domain/interfaces/service-client.interface";
import { IRequestContext } from "../../domain/interfaces/request-context.interface";
import {
  IServiceResponse,
  IServiceError,
} from "../../domain/interfaces/service-response.interface";
import { logger } from "../../../entities/shared/infraestructure/utils/logger";

/**
 * Base service client using undici for high-performance HTTP requests.
 * Provides retry logic, timeout handling, and correlation ID propagation.
 */
export abstract class BaseServiceClient implements IServiceClient {
  public readonly serviceName: string;
  public readonly config: IServiceConfig;

  constructor(config: IServiceConfig) {
    this.serviceName = config.name;
    this.config = config;
  }

  /**
   * Make a request to the backend service with retry logic
   */
  async request<T>(
    options: IServiceRequestOptions,
    context: IRequestContext
  ): Promise<IServiceResponse<T>> {
    const startTime = Date.now();
    const maxRetries = options.retries ?? this.config.retries;
    const timeout = options.timeout ?? this.config.timeout;

    let lastError: IServiceError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.executeRequest<T>(
          options,
          context,
          timeout
        );

        const duration = Date.now() - startTime;

        logger.debug(`Service call completed`, {
          service: this.serviceName,
          path: options.path,
          method: options.method,
          statusCode: response.statusCode,
          duration,
          attempt,
        });

        return {
          ...response,
          duration,
        };
      } catch (error) {
        lastError = this.createServiceError(error, options.path);

        logger.warn(`Service call failed, attempt ${attempt + 1}/${maxRetries + 1}`, {
          service: this.serviceName,
          path: options.path,
          method: options.method,
          error: lastError,
          attempt,
        });

        // Don't retry on client errors (4xx)
        if (lastError.code.startsWith("4")) {
          break;
        }

        // Wait before retry (exponential backoff)
        if (attempt < maxRetries) {
          await this.delay(Math.pow(2, attempt) * 100);
        }
      }
    }

    const duration = Date.now() - startTime;

    return {
      success: false,
      error: lastError,
      statusCode: this.getStatusCodeFromError(lastError),
      duration,
    };
  }

  /**
   * Execute a single HTTP request
   */
  private async executeRequest<T>(
    options: IServiceRequestOptions,
    context: IRequestContext,
    timeout: number
  ): Promise<IServiceResponse<T>> {
    const url = this.buildUrl(options.path, options.query);
    const headers = this.buildHeaders(options.headers, context);

    const requestOptions: Omit<Dispatcher.RequestOptions, "origin" | "path"> = {
      method: options.method,
      headers,
      headersTimeout: timeout,
      bodyTimeout: timeout,
    };

    if (options.body && ["POST", "PUT", "PATCH"].includes(options.method)) {
      requestOptions.body = JSON.stringify(options.body);
    }

    const response = await request(url, requestOptions);

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === "string") {
        responseHeaders[key] = value;
      } else if (Array.isArray(value)) {
        responseHeaders[key] = value.join(", ");
      }
    }

    // Parse response body
    let data: T | undefined;
    let error: IServiceError | undefined;

    const contentType = response.headers["content-type"];
    if (contentType && contentType.includes("application/json")) {
      const bodyText = await response.body.text();
      if (bodyText) {
        const parsed = JSON.parse(bodyText);

        if (response.statusCode >= 200 && response.statusCode < 300) {
          // Success response - extract data
          data = parsed.data ?? parsed;
        } else {
          // Error response
          error = {
            code: String(response.statusCode),
            message: parsed.error?.message || parsed.message || "Request failed",
            service: this.serviceName,
            details: parsed,
          };
        }
      }
    }

    const success = response.statusCode >= 200 && response.statusCode < 300;

    if (!success && !error) {
      error = {
        code: String(response.statusCode),
        message: `Request failed with status ${response.statusCode}`,
        service: this.serviceName,
      };
    }

    return {
      success,
      data,
      error,
      statusCode: response.statusCode,
      headers: responseHeaders,
      duration: 0, // Will be set by the caller
    };
  }

  /**
   * Build the full URL with query parameters
   */
  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>
  ): string {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    let url = `${baseUrl}${cleanPath}`;

    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.append(key, String(value));
        }
      }
      const queryString = params.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    return url;
  }

  /**
   * Build request headers with context propagation
   */
  private buildHeaders(
    customHeaders: Record<string, string> | undefined,
    context: IRequestContext
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Correlation-ID": context.correlationId,
    };

    // Forward authorization header
    if (context.authorizationHeader) {
      headers["Authorization"] = context.authorizationHeader;
    }

    // Add user context headers
    if (context.userId) {
      headers["X-User-ID"] = context.userId;
    }

    if (context.userRoles && context.userRoles.length > 0) {
      headers["X-User-Roles"] = context.userRoles.join(",");
    }

    // Add custom headers
    if (customHeaders) {
      Object.assign(headers, customHeaders);
    }

    return headers;
  }

  /**
   * Create a service error from an exception
   */
  private createServiceError(error: unknown, path: string): IServiceError {
    if (error instanceof Error) {
      // Check for timeout
      if (error.message.includes("timeout") || error.name === "TimeoutError") {
        return {
          code: "TIMEOUT",
          message: `Request to ${this.serviceName}${path} timed out`,
          service: this.serviceName,
        };
      }

      // Check for connection errors
      if (
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ENOTFOUND")
      ) {
        return {
          code: "CONNECTION_ERROR",
          message: `Cannot connect to ${this.serviceName}`,
          service: this.serviceName,
        };
      }

      return {
        code: "REQUEST_ERROR",
        message: error.message,
        service: this.serviceName,
      };
    }

    return {
      code: "UNKNOWN_ERROR",
      message: "An unknown error occurred",
      service: this.serviceName,
    };
  }

  /**
   * Get HTTP status code from error
   */
  private getStatusCodeFromError(error: IServiceError | undefined): number {
    if (!error) return 500;

    switch (error.code) {
      case "TIMEOUT":
        return 504;
      case "CONNECTION_ERROR":
        return 503;
      default:
        const code = parseInt(error.code, 10);
        return isNaN(code) ? 500 : code;
    }
  }

  /**
   * Delay helper for retries
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if the service is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const url = `${this.config.baseUrl}${this.config.healthPath}`;
      const response = await request(url, {
        method: "GET",
        headersTimeout: 3000,
        bodyTimeout: 3000,
      });

      return response.statusCode >= 200 && response.statusCode < 300;
    } catch {
      return false;
    }
  }
}
