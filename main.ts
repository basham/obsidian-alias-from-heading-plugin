import { debounce, MetadataCache, Notice, Plugin, ReferenceCache, TFile } from 'obsidian';

interface MetadataCacheExtra extends MetadataCache {
	fileCache: any;
	metadataCache: any;
}

export default class AliasFromHeadingPlugin extends Plugin {
	async onload () {
		const { metadataCache, vault, workspace } = this.app;
		const headingByPath = new Map();

		const clearHeadings = debounce((path) => {
			if (!headingByPath.has(path)) {
				return;
			}
			const heading = headingByPath.get(path);
			headingByPath.clear();
			headingByPath.set(path, heading);
		}, 10000, true);

		const loadFile = (file:TFile) => {
			if (!file) {
				return;
			}
			// Cache the current heading for each active or opened file.
			// Once a new file opens, clear out the old data after
			// a debounced 10 seconds. This gives plenty of time for
			// any links to be updated, if the user updates the heading
			// and quickly opens another file.
			const { path } = file;
			const heading = this.loadHeading(path);
			headingByPath.set(path, heading);
			clearHeadings(path);
		};

		workspace.onLayoutReady(() => loadFile(workspace.getActiveFile()));

		this.registerEvent(workspace.on('file-open', loadFile));

		this.registerEvent(vault.on('rename', (file, oldPath) => {
			if (!(file instanceof TFile)) {
				return;
			}
			const { path } = file;
			const heading = headingByPath.get(oldPath);
			headingByPath.set(path, heading);
		}));

		this.registerEvent(metadataCache.on('changed', async (file) => {
			const { path } = file;

			if (!headingByPath.has(path)) {
				return;
			}

			const prevHeading = headingByPath.get(path);
			const heading = this.loadHeading(path);
			headingByPath.set(path, heading);

			if (prevHeading === heading) {
				return;
			}

			const modifiedFiles = Object.entries(metadataCache.resolvedLinks)
				.reduce((paths, [toPath, links]) => {
					const hasRef = Object.keys(links).includes(path);
					return hasRef ? [...paths, toPath] : paths;
				}, [])
				.map((p:string) => {
					const { links = [] } = metadataCache.getCache(p);
					const linksToReplace = links
						.filter((rc:ReferenceCache) => rc.link.split('#')[0] === metadataCache.fileToLinktext(file, ''))
						.filter((rc:ReferenceCache) => rc.displayText === prevHeading || rc.displayText === rc.link)
						.filter((rc:ReferenceCache) => rc.original !== `[[${rc.link}]]`)
						.map((rc:ReferenceCache) => [
							rc.original,
							`[[${rc.link}|${heading === undefined ? rc.link : heading}]]`
						])
					return [p, linksToReplace];
				})
				.filter(([, linksToReplace]:[string, []]) => linksToReplace.length)
				.map(async ([p, linksToReplace]:[string, []]) => {
					const f = <TFile>vault.getAbstractFileByPath(p);
					const prevContents = await vault.read(f);
					const contents = linksToReplace.reduce(
						(source, [find, replace]:string[]) => source.replaceAll(find, replace),
						prevContents
					);
					await vault.modify(f, contents);
					return linksToReplace.length;
				})

			const fileCount = modifiedFiles.length;

			if (!fileCount) {
				return;
			}

			const linkCount = (await Promise.all(modifiedFiles))
				.reduce((sum, value) => sum + value, 0)

			new Notice(`Updated ${linkCount} ${pluralize(linkCount, 'link')} in ${fileCount} ${pluralize(fileCount, 'file')}.`);
		}));
	}

	loadHeading (path: string) {
		const { metadataCache } = this.app;
		const cache = metadataCache.getCache(path);
		const { frontmatter = {}, headings } = cache;
		if (!Array.isArray(headings) || !headings.length) {
			return;
		}
		const { heading } = headings[0];
		const { hash } = (<MetadataCacheExtra>metadataCache).fileCache[path];
		const { alias } = <any>frontmatter;
		const _alias = alias ? Array.isArray(alias) ? alias : [alias] : []
		const uniqueAlias = [...new Set([ heading, ..._alias ])];
		const updatedCache = {
			...cache,
			frontmatter: {
				...frontmatter,
				alias: uniqueAlias
			}
		};
		(<MetadataCacheExtra>metadataCache).metadataCache[hash] = updatedCache;
		return heading;
	}
}

function pluralize (count:number, singular:string, plural = `${singular}s`):string {
	return count === 1 ? singular : plural;
}
