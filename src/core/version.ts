// The build replaces FGJ_VERSION through `bun build --define`; a source run has none.
declare const FGJ_VERSION: string | undefined;

/** The build version, for example `0.0.0+c319e24`, or `dev` when run from source. */
export const VERSION: string =
	typeof FGJ_VERSION === "string" ? FGJ_VERSION : "dev";
