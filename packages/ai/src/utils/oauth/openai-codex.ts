/**
 * OpenAI Codex (ChatGPT OAuth) flow
 *
 * NOTE: This module uses Node.js crypto and http for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

// NEVER convert to top-level imports - breaks browser/Vite builds (web-ui)
let _randomBytes: typeof import("node:crypto").randomBytes | null = null;
let _http: typeof import("node:http") | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:crypto").then((m) => {
		_randomBytes = m.randomBytes;
	});
	import("node:http").then((m) => {
		_http = m;
	});
}

import { generatePKCE } from "./pkce.js";
import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const OPENAI_CODEX_MODELS_CLIENT_VERSION = process.env.PI_OPENAI_CODEX_CLIENT_VERSION || "0.124.0";
const OPENAI_CODEX_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const OPENAI_CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${OPENAI_CODEX_MODELS_CLIENT_VERSION}`;

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication successful</title>
</head>
<body>
  <p>Authentication successful. Return to your terminal to continue.</p>
</body>
</html>`;

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailure = { type: "failed" };
type TokenResult = TokenSuccess | TokenFailure;

type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
};

type OpenAICodexCredentials = OAuthCredentials & {
	accountId?: string;
};

type OpenAICodexCatalogModel = {
	slug?: string;
	display_name?: string;
	context_window?: number;
	max_context_window?: number;
	input_modalities?: string[];
	supported_reasoning_levels?: Array<{ effort?: string }>;
	supported_in_api?: boolean;
	visibility?: string;
};

const FIRST_CLASS_HIDDEN_OPENAI_CODEX_MODELS = new Set(["codex-auto-review"]);
const openAICodexModelsCache = new Map<string, { expiresAt: number; models: OpenAICodexCatalogModel[] }>();

function createState(): string {
	if (!_randomBytes) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}
	return _randomBytes(16).toString("hex");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function decodeJwt(token: string): JwtPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = atob(payload);
		return JSON.parse(decoded) as JwtPayload;
	} catch {
		return null;
	}
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string = REDIRECT_URI,
): Promise<TokenResult> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		console.error("[openai-codex] code->token failed:", response.status, text);
		return { type: "failed" };
	}

	const json = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		console.error("[openai-codex] token response missing fields:", json);
		return { type: "failed" };
	}

	return {
		type: "success",
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			console.error("[openai-codex] Token refresh failed:", response.status, text);
			return { type: "failed" };
		}

		const json = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};

		if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
			console.error("[openai-codex] Token refresh response missing fields:", json);
			return { type: "failed" };
		}

		return {
			type: "success",
			access: json.access_token,
			refresh: json.refresh_token,
			expires: Date.now() + json.expires_in * 1000,
		};
	} catch (error) {
		console.error("[openai-codex] Token refresh error:", error);
		return { type: "failed" };
	}
}

async function createAuthorizationFlow(
	originator: string = "pi",
): Promise<{ verifier: string; state: string; url: string }> {
	const { verifier, challenge } = await generatePKCE();
	const state = createState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", originator);

	return { verifier, state, url: url.toString() };
}

type OAuthServerInfo = {
	close: () => void;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string } | null>;
};

function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
	if (!_http) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}
	let lastCode: string | null = null;
	let cancelled = false;
	const server = _http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== "/auth/callback") {
				res.statusCode = 404;
				res.end("Not found");
				return;
			}
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.end("State mismatch");
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.end("Missing authorization code");
				return;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(SUCCESS_HTML);
			lastCode = code;
		} catch {
			res.statusCode = 500;
			res.end("Internal error");
		}
	});

	return new Promise((resolve) => {
		server
			.listen(1455, "127.0.0.1", () => {
				resolve({
					close: () => server.close(),
					cancelWait: () => {
						cancelled = true;
					},
					waitForCode: async () => {
						const sleep = () => new Promise((r) => setTimeout(r, 100));
						for (let i = 0; i < 600; i += 1) {
							if (lastCode) return { code: lastCode };
							if (cancelled) return null;
							await sleep();
						}
						return null;
					},
				});
			})
			.on("error", (err: NodeJS.ErrnoException) => {
				console.error(
					"[openai-codex] Failed to bind http://127.0.0.1:1455 (",
					err.code,
					") Falling back to manual paste.",
				);
				resolve({
					close: () => {
						try {
							server.close();
						} catch {
							// ignore
						}
					},
					cancelWait: () => {},
					waitForCode: async () => null,
				});
			});
	});
}

function getAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function getCredentialAccountId(credentials: OpenAICodexCredentials): string | null {
	if (typeof credentials.accountId === "string" && credentials.accountId.length > 0) {
		return credentials.accountId;
	}
	return getAccountId(credentials.access);
}

function normalizeOpenAICodexInputModalities(
	modalities: string[] | undefined,
	fallback: ("text" | "image")[],
): ("text" | "image")[] {
	const normalized = new Set<"text" | "image">();
	for (const modality of modalities ?? []) {
		if (modality === "text" || modality === "image") {
			normalized.add(modality);
		}
	}
	return normalized.size > 0 ? Array.from(normalized) : fallback;
}

function normalizeOpenAICodexReasoning(model: OpenAICodexCatalogModel, fallback: boolean): boolean {
	if (!Array.isArray(model.supported_reasoning_levels)) {
		return fallback;
	}
	return model.supported_reasoning_levels.some((level) => typeof level?.effort === "string" && level.effort.length > 0);
}

function shouldHydrateOpenAICodexModel(model: OpenAICodexCatalogModel): boolean {
	const id = model.slug?.trim();
	if (!id) {
		return false;
	}
	if (model.visibility !== "hide") {
		return true;
	}
	return FIRST_CLASS_HIDDEN_OPENAI_CODEX_MODELS.has(id) && model.supported_in_api !== false;
}

async function fetchOpenAICodexCatalog(
	credentials: OpenAICodexCredentials,
): Promise<OpenAICodexCatalogModel[] | undefined> {
	if (process.env.PI_OFFLINE) {
		return undefined;
	}

	const accountId = getCredentialAccountId(credentials);
	if (!credentials.access || !accountId) {
		return undefined;
	}

	const now = Date.now();
	const cached = openAICodexModelsCache.get(accountId);
	if (cached && cached.expiresAt > now) {
		return cached.models;
	}

	const response = await fetch(OPENAI_CODEX_MODELS_URL, {
		headers: {
			Authorization: `Bearer ${credentials.access}`,
			"chatgpt-account-id": accountId,
			"User-Agent": `pi/${OPENAI_CODEX_MODELS_CLIENT_VERSION}`,
		},
	});
	if (!response.ok) {
		return undefined;
	}

	const payload = (await response.json()) as { models?: OpenAICodexCatalogModel[] };
	if (!Array.isArray(payload.models)) {
		return undefined;
	}

	openAICodexModelsCache.set(accountId, {
		expiresAt: now + OPENAI_CODEX_MODELS_CACHE_TTL_MS,
		models: payload.models,
	});
	return payload.models;
}

export async function hydrateOpenAICodexModels(
	models: Model<Api>[],
	credentials: OAuthCredentials,
): Promise<Model<Api>[]> {
	const catalog = await fetchOpenAICodexCatalog(credentials as OpenAICodexCredentials);
	if (!catalog) {
		return models;
	}

	const providerModels = models.filter((model) => model.provider === "openai-codex");
	const providerTemplate = providerModels[0];
	const byId = new Map(providerModels.map((model) => [model.id, model]));
	const hydratedProviderModels: Model<Api>[] = [];

	for (const entry of catalog) {
		const id = entry.slug?.trim();
		if (!id || !shouldHydrateOpenAICodexModel(entry)) {
			continue;
		}

		const existing = byId.get(id);
		const fallbackInput = existing?.input ?? providerTemplate?.input ?? ["text"];
		const fallbackContextWindow = existing?.contextWindow ?? providerTemplate?.contextWindow ?? 272000;
		const fallbackMaxTokens = existing?.maxTokens ?? providerTemplate?.maxTokens ?? 128000;
		const fallbackCost = existing?.cost ?? providerTemplate?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

		hydratedProviderModels.push({
			id,
			name: entry.display_name?.trim() || existing?.name || id,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: existing?.baseUrl ?? providerTemplate?.baseUrl ?? "https://chatgpt.com/backend-api",
			reasoning: normalizeOpenAICodexReasoning(entry, existing?.reasoning ?? providerTemplate?.reasoning ?? true),
			input: normalizeOpenAICodexInputModalities(entry.input_modalities, fallbackInput),
			cost: fallbackCost,
			contextWindow: entry.context_window ?? entry.max_context_window ?? fallbackContextWindow,
			maxTokens: fallbackMaxTokens,
			headers: existing?.headers ?? providerTemplate?.headers,
			compat: existing?.compat ?? providerTemplate?.compat,
		} satisfies Model<Api>);
	}

	if (hydratedProviderModels.length === 0) {
		return models;
	}

	const otherModels = models.filter((model) => model.provider !== "openai-codex");
	return [...otherModels, ...hydratedProviderModels];
}

/**
 * Login with OpenAI Codex OAuth
 *
 * @param options.onAuth - Called with URL and instructions when auth starts
 * @param options.onPrompt - Called to prompt user for manual code paste (fallback if no onManualCodeInput)
 * @param options.onProgress - Optional progress messages
 * @param options.onManualCodeInput - Optional promise that resolves with user-pasted code.
 *                                    Races with browser callback - whichever completes first wins.
 *                                    Useful for showing paste input immediately alongside browser flow.
 * @param options.originator - OAuth originator parameter (defaults to "pi")
 */
export async function loginOpenAICodex(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	originator?: string;
}): Promise<OAuthCredentials> {
	const { verifier, state, url } = await createAuthorizationFlow(options.originator);
	const server = await startLocalOAuthServer(state);

	options.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });

	let code: string | undefined;
	try {
		if (options.onManualCodeInput) {
			// Race between browser callback and manual input
			let manualCode: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualCode = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			// If manual input was cancelled, throw that error
			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				// Browser callback won
				code = result.code;
			} else if (manualCode) {
				// Manual input won (or callback timed out and user had entered code)
				const parsed = parseAuthorizationInput(manualCode);
				if (parsed.state && parsed.state !== state) {
					throw new Error("State mismatch");
				}
				code = parsed.code;
			}

			// If still no code, wait for manual promise to complete and try that
			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualCode) {
					const parsed = parseAuthorizationInput(manualCode);
					if (parsed.state && parsed.state !== state) {
						throw new Error("State mismatch");
					}
					code = parsed.code;
				}
			}
		} else {
			// Original flow: wait for callback, then prompt if needed
			const result = await server.waitForCode();
			if (result?.code) {
				code = result.code;
			}
		}

		// Fallback to onPrompt if still no code
		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code (or full redirect URL):",
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== state) {
				throw new Error("State mismatch");
			}
			code = parsed.code;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		const tokenResult = await exchangeAuthorizationCode(code, verifier);
		if (tokenResult.type !== "success") {
			throw new Error("Token exchange failed");
		}

		const accountId = getAccountId(tokenResult.access);
		if (!accountId) {
			throw new Error("Failed to extract accountId from token");
		}

		return {
			access: tokenResult.access,
			refresh: tokenResult.refresh,
			expires: tokenResult.expires,
			accountId,
		};
	} finally {
		server.close();
	}
}

/**
 * Refresh OpenAI Codex OAuth token
 */
export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
	const result = await refreshAccessToken(refreshToken);
	if (result.type !== "success") {
		throw new Error("Failed to refresh OpenAI Codex token");
	}

	const accountId = getAccountId(result.access);
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}

	return {
		access: result.access,
		refresh: result.refresh,
		expires: result.expires,
		accountId,
	};
}

export const openaiCodexOAuthProvider: OAuthProviderInterface = {
	id: "openai-codex",
	name: "ChatGPT Plus/Pro (Codex Subscription)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginOpenAICodex({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshOpenAICodexToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	async modifyModelsAsync(models: Model<Api>[], credentials: OAuthCredentials): Promise<Model<Api>[]> {
		return hydrateOpenAICodexModels(models, credentials);
	},
};
