// @types/bun 1.3 omits the standard Fetch cache option that Bun supports at runtime.
interface RequestInit {
	cache?: "default" | "no-store" | "reload" | "no-cache" | "force-cache" | "only-if-cached";
}
