// Bun imports a Markdown file as its text with `with { type: "text" }`.
declare module "*.md" {
	const text: string;
	export default text;
}
