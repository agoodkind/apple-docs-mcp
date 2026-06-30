import type {
  CallToolResult,
  ContentBlock,
  ImageContent,
  ListResourcesResult,
  ReadResourceResult,
  Resource,
  ResourceLink,
} from '@modelcontextprotocol/sdk/types.js';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { designContentCache, designResourcesCache } from '../utils/cache.js';
import { APPLE_URLS, REQUEST_CONFIG } from '../utils/constants.js';
import { httpClient } from '../utils/http-client.js';
import { convertToDesignJsonApiUrl } from '../utils/url-converter.js';

const APPLE_DESIGN_DOWNLOAD_HOSTS = new Set([
  'developer.apple.com',
  'docs-assets.developer.apple.com',
  'devimages-cdn.apple.com',
  'itunespartner.apple.com',
]);
const DEFAULT_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const DIRECT_RESOURCE_EXTENSIONS = new Set([
  '.dmg',
  '.fig',
  '.gif',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.sketch',
  '.svg',
  '.webp',
  '.zip',
]);
const IMAGE_MIME_PREFIX = 'image/';
const RESOURCE_URI_PREFIX = 'apple-design://cache/';

export interface DesignResourceCatalogEntry {
  resourceId: string;
  category: string;
  platform?: string;
  title: string;
  downloadLabel: string;
  downloadUrl: string;
  format: string;
  note?: string;
  previewImageUrl?: string;
  relatedGuidelineLinks: string[];
}

interface CachedDesignResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  filePath: string;
  sourceUrl: string;
  size: number;
}

interface DesignSearchResult {
  title: string;
  type: 'hig' | 'resource' | 'page';
  url: string;
  description?: string;
  resourceId?: string;
  platform?: string;
  format?: string;
  previewImageUrl?: string;
}

interface DesignImageCandidate {
  url: string;
  alt?: string;
}

export interface SearchAppleDesignDocsArgs {
  query: string;
  contentType?: 'all' | 'hig' | 'resource' | 'page';
  platform?: string;
  limit?: number;
}

export interface ListAppleDesignResourcesArgs {
  category?: string;
  platform?: string;
  format?: string;
  searchQuery?: string;
  limit?: number;
}

export interface DownloadAppleDesignResourceArgs {
  resourceId?: string;
  url?: string;
  maxBytes?: number;
}

export interface GetAppleDesignExamplesArgs {
  url?: string;
  resourceId?: string;
  query?: string;
  limit?: number;
}

const cachedResourcesByUri = new Map<string, CachedDesignResource>();
const cachedResourcesBySourceUrl = new Map<string, CachedDesignResource>();
const resourceCatalogById = new Map<string, DesignResourceCatalogEntry>();

/**
 * Format Apple Design HIG JSON as readable Markdown.
 * @param jsonData Apple Design JSON payload.
 * @param originalUrl Source Apple Design URL.
 * @returns Markdown content.
 */
export function formatAppleDesignDocument(jsonData: unknown, originalUrl: string): string {
  const documentRecord = asRecord(jsonData);
  if (!documentRecord) {
    return `# Apple Design\n\nUnable to parse Apple Design content.\n\n---\n\n[View on Apple Developer](${originalUrl})`;
  }

  const references = getRecordMap(documentRecord.references);
  const metadata = asRecord(documentRecord.metadata);
  const title = getString(metadata, 'title') ?? getString(documentRecord, 'title') ?? 'Apple Design';
  let content = `# ${title}\n\n`;

  const abstractText = renderInlineCollection(
    getArray(documentRecord.abstract).length > 0
      ? getArray(documentRecord.abstract)
      : getArray(metadata?.abstract),
    references,
    originalUrl,
  );
  if (abstractText) {
    content += `${abstractText}\n\n`;
  }

  const supportedPlatforms = getSupportedPlatforms(documentRecord);
  if (supportedPlatforms.length > 0) {
    content += '## Supported Platforms\n\n';
    content += `${supportedPlatforms.map(platform => `- ${platform}`).join('\n')}\n\n`;
  }

  const alertText = getCustomMetadataString(documentRecord, 'alert-text');
  const alertDate = getCustomMetadataString(documentRecord, 'alert-date');
  if (alertText) {
    content += '## Alert\n\n';
    if (alertDate) {
      content += `**${alertDate}**: `;
    }
    content += `${alertText}\n\n`;
  }

  const primarySections = getRecordArray(documentRecord.primaryContentSections);
  for (const section of primarySections) {
    content += formatDesignContentSection(section, references, originalUrl, 2);
  }

  const topicSections = getRecordArray(documentRecord.topicSections);
  if (topicSections.length > 0) {
    content += formatTopicSections(topicSections, references, originalUrl);
  }

  const secondarySections = getRecordArray(documentRecord.sections);
  for (const section of secondarySections) {
    content += formatSecondarySection(section, references, originalUrl);
  }

  content += `---\n\n[View on Apple Developer](${originalUrl})`;
  return content;
}

/**
 * Parse static Apple Design HTML pages as Markdown.
 * @param html Apple Design HTML.
 * @param sourceUrl Source URL.
 * @returns Markdown content.
 */
export function parseAppleDesignHtmlPage(html: string, sourceUrl: string): string {
  const $ = cheerio.load(html);
  const mainElement = $('main').first();
  const rootElement = mainElement.length > 0 ? mainElement : $('body').first();
  const title = normalizeWhitespace(rootElement.find('h1').first().text())
    || normalizeWhitespace($('title').first().text())
    || 'Apple Design';
  let content = `# ${title}\n\n`;

  rootElement.find('p').each((_index, element) => {
    const paragraph = normalizeWhitespace($(element).text());
    if (paragraph) {
      content += `${paragraph}\n\n`;
    }
  });

  const links = new Map<string, { title: string; description?: string }>();
  rootElement.find('a[href]').each((_index, element) => {
    const linkElement = $(element);
    const href = linkElement.attr('href');
    const normalizedUrl = normalizeUrl(href, sourceUrl);
    if (!normalizedUrl) {
      return;
    }

    const parsedUrl = safeUrl(normalizedUrl);
    if (!parsedUrl || parsedUrl.hostname !== 'developer.apple.com' || !parsedUrl.pathname.startsWith('/design/')) {
      return;
    }

    const linkTitle = normalizeWhitespace(
      linkElement.find('h2, h3, h4, h5').first().text(),
    ) || normalizeWhitespace(linkElement.text());
    if (!linkTitle) {
      return;
    }

    const description = normalizeWhitespace(linkElement.find('p').first().text());
    links.set(normalizedUrl, {
      title: linkTitle,
      description: description || undefined,
    });
  });

  if (links.size > 0) {
    content += '## Links\n\n';
    for (const [url, link] of links.entries()) {
      content += `- [${link.title}](${url})`;
      if (link.description) {
        content += `: ${link.description}`;
      }
      content += '\n';
    }
    content += '\n';
  }

  content += `---\n\n[View on Apple Developer](${sourceUrl})`;
  return content;
}

/**
 * Parse Apple Design Resources HTML into catalog entries.
 * @param html Apple Design Resources HTML.
 * @param sourceUrl Source URL.
 * @returns Resource catalog entries.
 */
export function parseDesignResourcesHtml(
  html: string,
  sourceUrl: string,
): DesignResourceCatalogEntry[] {
  const $ = cheerio.load(html);
  const entries: DesignResourceCatalogEntry[] = [];
  const seenResourceIds = new Map<string, number>();
  const sections = $('section.section-download');
  const sectionElements = sections.length > 0 ? sections : $('section');

  sectionElements.each((_sectionIndex, sectionElement) => {
    const section = $(sectionElement);
    const category = normalizeWhitespace(section.find('h2').first().text()) || 'Design Resources';
    let currentPlatform = '';

    section.children().each((_childIndex, childElement) => {
      const child = $(childElement);
      if (child.is('h3, h4')) {
        currentPlatform = normalizeWhitespace(child.text());
      }

      const itemElements = child.hasClass('grid-item') ? child : child.find('.grid-item');
      itemElements.each((_itemIndex, itemElement) => {
        const item = $(itemElement);
        const platform = currentPlatform || findNearestHeadingText($, item);
        const itemEntries = parseDesignResourceItem(
          $,
          item,
          category,
          platform,
          sourceUrl,
          seenResourceIds,
        );
        entries.push(...itemEntries);
      });
    });
  });

  return entries;
}

/**
 * Search Apple Design, HIG, and Design Resources content.
 * @param args Search arguments.
 * @returns MCP tool result.
 */
export async function handleSearchAppleDesignDocs(
  args: SearchAppleDesignDocsArgs,
): Promise<CallToolResult> {
  const query = args.query.trim();
  const contentType = args.contentType ?? 'all';
  const platform = args.platform ?? 'all';
  const limit = args.limit ?? 20;

  const results = await collectDesignSearchResults(query, contentType, platform, limit);
  return {
    content: [
      createTextContent(formatDesignSearchResults(results, query)),
    ],
  };
}

/**
 * Read an Apple Design URL.
 * @param args Content arguments.
 * @returns MCP tool result.
 */
export async function handleGetAppleDesignContent(
  args: { url: string } | string,
): Promise<CallToolResult> {
  const url = typeof args === 'string' ? args : args.url;
  const content = await fetchAppleDesignContent(url);
  return {
    content: [
      createTextContent(content),
    ],
  };
}

/**
 * List Apple Design Resources catalog entries.
 * @param args List arguments.
 * @returns MCP tool result.
 */
export async function handleListAppleDesignResources(
  args: ListAppleDesignResourcesArgs = {},
): Promise<CallToolResult> {
  const resources = await getDesignResourcesCatalog();
  const filteredResources = filterDesignResources(resources, args);
  const limitedResources = filteredResources.slice(0, args.limit ?? 50);

  return {
    content: [
      createTextContent(formatDesignResources(limitedResources)),
    ],
  };
}

/**
 * Download a direct Apple Design resource into the local MCP cache.
 * @param args Download arguments.
 * @returns MCP tool result.
 */
export async function handleDownloadAppleDesignResource(
  args: DownloadAppleDesignResourceArgs,
): Promise<CallToolResult> {
  const resource = await resolveDownloadResource(args);
  if (!resource.downloadUrl) {
    throw new Error('A resourceId or direct URL is required.');
  }

  if (!isDirectAppleDownloadUrl(resource.downloadUrl)) {
    if (!args.resourceId) {
      validateDownloadUrl(resource.downloadUrl);
    }

    return {
      content: [
        createTextContent(formatNonDownloadableResource(resource)),
      ],
    };
  }

  validateDownloadUrl(resource.downloadUrl);
  const cachedResource = await downloadDesignResource(resource, args.maxBytes);
  return {
    content: await createDownloadedResourceContent(cachedResource),
  };
}

/**
 * Return visual examples as MCP image content blocks.
 * @param args Example lookup arguments.
 * @returns MCP tool result.
 */
export async function handleGetAppleDesignExamples(
  args: GetAppleDesignExamplesArgs = {},
): Promise<CallToolResult> {
  const limit = args.limit ?? 3;
  const candidates = await collectImageCandidates(args);
  const uniqueCandidates = dedupeImageCandidates(candidates).slice(0, limit);
  const content: ContentBlock[] = [
    createTextContent(`Apple Design Examples\n\nFound ${uniqueCandidates.length} image example${uniqueCandidates.length === 1 ? '' : 's'}.`),
  ];

  for (const candidate of uniqueCandidates) {
    const imageContent = await fetchImageContent(candidate.url);
    if (imageContent) {
      content.push(imageContent);
    }
  }

  if (content.length === 1) {
    content[0] = createTextContent('Apple Design Examples\n\nNo directly fetchable image examples were found.');
  }

  return { content };
}

/**
 * List cached downloaded resources for MCP resources/list.
 * @returns MCP resources/list result.
 */
export async function listCachedDesignResources(): Promise<ListResourcesResult> {
  const resources: Resource[] = [];
  for (const cachedResource of cachedResourcesByUri.values()) {
    resources.push({
      uri: cachedResource.uri,
      name: cachedResource.name,
      title: cachedResource.title,
      description: cachedResource.description,
      mimeType: cachedResource.mimeType,
    });
  }

  return { resources };
}

/**
 * Read cached downloaded resources for MCP resources/read.
 * @param uri Resource URI.
 * @returns MCP resources/read result.
 */
export async function readCachedDesignResource(uri: string): Promise<ReadResourceResult> {
  const cachedResource = cachedResourcesByUri.get(uri);
  if (!cachedResource) {
    throw new Error(`Unknown Apple Design resource URI: ${uri}`);
  }

  const data = await readFile(cachedResource.filePath);
  return {
    contents: [
      {
        uri: cachedResource.uri,
        mimeType: cachedResource.mimeType,
        blob: data.toString('base64'),
      },
    ],
  };
}

/**
 * Clear process-local Design download state for tests.
 * @returns Nothing.
 */
export function clearDesignResourceCacheForTesting(): void {
  cachedResourcesByUri.clear();
  cachedResourcesBySourceUrl.clear();
  resourceCatalogById.clear();
}

async function fetchAppleDesignContent(url: string): Promise<string> {
  const cacheKey = `design-content:${url}`;
  const cachedContent = designContentCache.get<string>(cacheKey);
  if (cachedContent) {
    return cachedContent;
  }

  const jsonUrl = convertToDesignJsonApiUrl(url);
  let content: string;
  if (jsonUrl) {
    const jsonData = await httpClient.getJson<unknown>(jsonUrl);
    content = formatAppleDesignDocument(jsonData, url);
  } else {
    const html = await httpClient.getText(url);
    if (isDesignResourcesUrl(url)) {
      const resources = parseDesignResourcesHtml(html, url);
      updateResourceCatalogIndex(resources);
      content = `${parseAppleDesignHtmlPage(html, url)}\n\n${formatDesignResources(resources)}`;
    } else {
      content = parseAppleDesignHtmlPage(html, url);
    }
  }

  designContentCache.set(cacheKey, content);
  return content;
}

async function getDesignResourcesCatalog(): Promise<DesignResourceCatalogEntry[]> {
  const cachedResources = designResourcesCache.get<DesignResourceCatalogEntry[]>('design-resources');
  if (cachedResources) {
    updateResourceCatalogIndex(cachedResources);
    return cachedResources;
  }

  const html = await httpClient.getText(APPLE_URLS.DESIGN_RESOURCES);
  const resources = parseDesignResourcesHtml(html, APPLE_URLS.DESIGN_RESOURCES);
  updateResourceCatalogIndex(resources);
  designResourcesCache.set('design-resources', resources);
  return resources;
}

async function collectDesignSearchResults(
  query: string,
  contentType: 'all' | 'hig' | 'resource' | 'page',
  platform: string,
  limit: number,
): Promise<DesignSearchResult[]> {
  const normalizedQuery = query.toLowerCase();
  const results: DesignSearchResult[] = [];

  if (contentType === 'all' || contentType === 'hig') {
    const higResults = await collectHigSearchResults(normalizedQuery);
    results.push(...higResults);
  }

  if (contentType === 'all' || contentType === 'resource') {
    const resources = await getDesignResourcesCatalog();
    for (const resource of resources) {
      if (!resourceMatchesPlatform(resource, platform)) {
        continue;
      }
      const searchableText = [
        resource.title,
        resource.category,
        resource.platform,
        resource.downloadLabel,
        resource.format,
        resource.note,
      ].filter(Boolean).join(' ').toLowerCase();

      if (!searchableText.includes(normalizedQuery)) {
        continue;
      }

      results.push({
        title: resource.title,
        type: 'resource',
        url: resource.downloadUrl,
        description: resource.note,
        resourceId: resource.resourceId,
        platform: resource.platform,
        format: resource.format,
        previewImageUrl: resource.previewImageUrl,
      });
    }
  }

  if (contentType === 'all' || contentType === 'page') {
    const pageResults = getStaticDesignPageResults(normalizedQuery);
    results.push(...pageResults);
  }

  return results.slice(0, limit);
}

async function collectHigSearchResults(query: string): Promise<DesignSearchResult[]> {
  try {
    const rootJson = await httpClient.getJson<unknown>(APPLE_URLS.DESIGN_HIG_JSON);
    const documentRecord = asRecord(rootJson);
    if (!documentRecord) {
      return [];
    }

    const references = getRecordMap(documentRecord.references);
    const results: DesignSearchResult[] = [];
    const metadata = asRecord(documentRecord.metadata);
    const rootTitle = getString(metadata, 'title') ?? 'Human Interface Guidelines';
    const rootAbstract = renderInlineCollection(getArray(documentRecord.abstract), references, APPLE_URLS.DESIGN);
    if (`${rootTitle} ${rootAbstract}`.toLowerCase().includes(query)) {
      results.push({
        title: rootTitle,
        type: 'hig',
        url: 'https://developer.apple.com/design/human-interface-guidelines',
        description: rootAbstract,
      });
    }

    for (const reference of references.values()) {
      const title = getString(reference, 'title');
      const url = normalizeReferenceUrl(reference, APPLE_URLS.DESIGN);
      if (!title || !url || !url.includes('/design/human-interface-guidelines')) {
        continue;
      }

      const description = renderInlineCollection(getArray(reference.abstract), references, APPLE_URLS.DESIGN);
      if (`${title} ${description}`.toLowerCase().includes(query)) {
        results.push({
          title,
          type: 'hig',
          url,
          description,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

function getStaticDesignPageResults(query: string): DesignSearchResult[] {
  const pages: DesignSearchResult[] = [
    {
      title: 'Apple Design',
      type: 'page',
      url: APPLE_URLS.DESIGN,
      description: 'Apple Design guidance, videos, resources, and Human Interface Guidelines.',
    },
    {
      title: 'Design Resources',
      type: 'page',
      url: APPLE_URLS.DESIGN_RESOURCES,
      description: 'Templates, product bezels, fonts, tools, and downloadable resources.',
    },
    {
      title: 'What is new in Apple Design',
      type: 'page',
      url: 'https://developer.apple.com/design/whats-new/',
      description: 'Recent Apple Design updates and platform guidance.',
    },
    {
      title: 'Get started with Apple Design',
      type: 'page',
      url: 'https://developer.apple.com/design/get-started/',
      description: 'Introductory Apple Design guidance.',
    },
  ];

  return pages.filter(page => {
    const searchableText = `${page.title} ${page.description ?? ''}`.toLowerCase();
    return searchableText.includes(query);
  });
}

function formatDesignSearchResults(results: DesignSearchResult[], query: string): string {
  let content = `# Apple Design Search Results\n\nQuery: "${query}"\n\n`;
  if (results.length === 0) {
    return `${content}No Apple Design results found.`;
  }

  results.forEach((result, index) => {
    content += `## ${index + 1}. ${result.title}\n\n`;
    content += `- Type: ${result.type}\n`;
    content += `- URL: ${result.url}\n`;
    if (result.resourceId) {
      content += `- Resource ID: ${result.resourceId}\n`;
    }
    if (result.platform) {
      content += `- Platform: ${result.platform}\n`;
    }
    if (result.format) {
      content += `- Format: ${result.format}\n`;
    }
    if (result.previewImageUrl) {
      content += `- Preview: ${result.previewImageUrl}\n`;
    }
    if (result.description) {
      content += `\n${result.description}\n`;
    }
    content += '\n';
  });

  return content.trimEnd();
}

function filterDesignResources(
  resources: DesignResourceCatalogEntry[],
  args: ListAppleDesignResourcesArgs,
): DesignResourceCatalogEntry[] {
  return resources.filter(resource => {
    if (args.category && !containsText(resource.category, args.category)) {
      return false;
    }
    if (args.platform && !containsText(resource.platform, args.platform)) {
      return false;
    }
    if (args.format && !containsText(resource.format, args.format)) {
      return false;
    }
    if (args.searchQuery) {
      const searchableText = [
        resource.title,
        resource.category,
        resource.platform,
        resource.downloadLabel,
        resource.format,
        resource.note,
      ].filter(Boolean).join(' ');
      if (!containsText(searchableText, args.searchQuery)) {
        return false;
      }
    }
    return true;
  });
}

function formatDesignResources(resources: DesignResourceCatalogEntry[]): string {
  let content = '# Apple Design Resources\n\n';
  if (resources.length === 0) {
    return `${content}No matching Design Resources found.`;
  }

  for (const resource of resources) {
    content += `## ${resource.title}\n\n`;
    content += `- Resource ID: ${resource.resourceId}\n`;
    content += `- Category: ${resource.category}\n`;
    if (resource.platform) {
      content += `- Platform: ${resource.platform}\n`;
    }
    content += `- Format: ${resource.format}\n`;
    content += `- Download Label: ${resource.downloadLabel}\n`;
    content += `- Download URL: ${resource.downloadUrl}\n`;
    if (resource.previewImageUrl) {
      content += `- Preview Image URL: ${resource.previewImageUrl}\n`;
    }
    if (resource.note) {
      content += `- Notes: ${resource.note}\n`;
    }
    if (resource.relatedGuidelineLinks.length > 0) {
      content += `- Related HIG Links: ${resource.relatedGuidelineLinks.join(', ')}\n`;
    }
    content += '\n';
  }

  return content.trimEnd();
}

async function resolveDownloadResource(
  args: DownloadAppleDesignResourceArgs,
): Promise<DesignResourceCatalogEntry> {
  if (args.resourceId) {
    if (!resourceCatalogById.has(args.resourceId)) {
      await getDesignResourcesCatalog();
    }

    const resource = resourceCatalogById.get(args.resourceId);
    if (!resource) {
      throw new Error(`Unknown Apple Design resourceId: ${args.resourceId}`);
    }
    return resource;
  }

  if (!args.url) {
    throw new Error('A resourceId or direct URL is required.');
  }

  return {
    resourceId: `direct:${hashString(args.url).slice(0, 12)}`,
    category: 'Direct URL',
    title: getFilenameFromUrl(args.url),
    downloadLabel: 'Download',
    downloadUrl: args.url,
    format: inferFormat(args.url, 'Download'),
    relatedGuidelineLinks: [],
  };
}

async function downloadDesignResource(
  resource: DesignResourceCatalogEntry,
  maxBytes: number | undefined,
): Promise<CachedDesignResource> {
  const normalizedSourceUrl = resource.downloadUrl;
  const cachedResource = cachedResourcesBySourceUrl.get(normalizedSourceUrl);
  if (cachedResource) {
    return cachedResource;
  }

  const byteLimit = maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  const response = await httpClient.get(normalizedSourceUrl, {
    timeout: REQUEST_CONFIG.TIMEOUT,
    headers: {
      Accept: '*/*',
    },
  });

  const contentLength = getContentLength(response);
  if (contentLength !== undefined && contentLength > byteLimit) {
    throw new Error(`Apple Design resource exceeds the ${byteLimit} byte download limit.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer);
  if (data.length > byteLimit) {
    throw new Error(`Apple Design resource exceeds the ${byteLimit} byte download limit.`);
  }

  const mimeType = detectMimeType(response.headers.get('content-type'), normalizedSourceUrl);
  const hash = hashBuffer(data);
  const filename = sanitizeFilename(getFilenameFromUrl(normalizedSourceUrl));
  const cacheDirectory = getDesignCacheDirectory();
  await mkdir(cacheDirectory, { recursive: true });

  const filePath = path.join(cacheDirectory, `${hash}-${filename}`);
  await writeFile(filePath, data);

  const uri = `${RESOURCE_URI_PREFIX}${hash}/${filename}`;
  const newCachedResource: CachedDesignResource = {
    uri,
    name: filename,
    title: resource.title,
    description: `${resource.category}${resource.platform ? `, ${resource.platform}` : ''}`,
    mimeType,
    filePath,
    sourceUrl: normalizedSourceUrl,
    size: data.length,
  };

  cachedResourcesByUri.set(uri, newCachedResource);
  cachedResourcesBySourceUrl.set(normalizedSourceUrl, newCachedResource);
  return newCachedResource;
}

async function createDownloadedResourceContent(
  cachedResource: CachedDesignResource,
): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [
    createTextContent(
      `Downloaded Apple Design resource: ${cachedResource.name}\n\n` +
      `- URI: ${cachedResource.uri}\n` +
      `- MIME Type: ${cachedResource.mimeType}\n` +
      `- Size: ${cachedResource.size} bytes`,
    ),
  ];

  if (isImageMimeType(cachedResource.mimeType)) {
    const data = await readFile(cachedResource.filePath);
    content.push({
      type: 'image',
      data: data.toString('base64'),
      mimeType: cachedResource.mimeType,
    });
  }

  content.push(createResourceLink(cachedResource));
  return content;
}

function formatNonDownloadableResource(resource: DesignResourceCatalogEntry): string {
  return (
    '# Apple Design Resource\n\n' +
    `${resource.title} is catalog metadata or an external design-tool link, so it was not downloaded.\n\n` +
    `- Resource ID: ${resource.resourceId}\n` +
    `- Format: ${resource.format}\n` +
    `- URL: ${resource.downloadUrl}`
  );
}

async function collectImageCandidates(args: GetAppleDesignExamplesArgs): Promise<DesignImageCandidate[]> {
  const candidates: DesignImageCandidate[] = [];

  if (args.resourceId) {
    if (!resourceCatalogById.has(args.resourceId)) {
      await getDesignResourcesCatalog();
    }
    const resource = resourceCatalogById.get(args.resourceId);
    if (resource?.previewImageUrl) {
      candidates.push({
        url: resource.previewImageUrl,
        alt: resource.title,
      });
    }
  }

  if (args.query) {
    const resources = filterDesignResources(await getDesignResourcesCatalog(), {
      searchQuery: args.query,
      limit: args.limit,
    });
    for (const resource of resources) {
      if (resource.previewImageUrl) {
        candidates.push({
          url: resource.previewImageUrl,
          alt: resource.title,
        });
      }
    }
  }

  if (args.url) {
    const url = args.url;
    if (isDirectImageUrl(url)) {
      candidates.push({ url });
    } else {
      const jsonUrl = convertToDesignJsonApiUrl(url);
      if (jsonUrl) {
        const jsonData = await httpClient.getJson<unknown>(jsonUrl);
        candidates.push(...extractImageCandidatesFromDesignDocument(jsonData, url));
      } else {
        const html = await httpClient.getText(url);
        candidates.push(...extractImageCandidatesFromHtml(html, url));
      }
    }
  }

  return candidates;
}

async function fetchImageContent(url: string): Promise<ImageContent | null> {
  const parsedUrl = safeUrl(url);
  if (!parsedUrl || !APPLE_DESIGN_DOWNLOAD_HOSTS.has(parsedUrl.hostname)) {
    return null;
  }

  const response = await httpClient.get(url, {
    timeout: REQUEST_CONFIG.TIMEOUT,
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });
  const mimeType = detectMimeType(response.headers.get('content-type'), url);
  if (!isImageMimeType(mimeType)) {
    return null;
  }

  const data = Buffer.from(await response.arrayBuffer());
  return {
    type: 'image',
    data: data.toString('base64'),
    mimeType,
  };
}

function extractImageCandidatesFromDesignDocument(
  jsonData: unknown,
  sourceUrl: string,
): DesignImageCandidate[] {
  const documentRecord = asRecord(jsonData);
  if (!documentRecord) {
    return [];
  }

  const references = getRecordMap(documentRecord.references);
  const candidates: DesignImageCandidate[] = [];
  for (const reference of references.values()) {
    if (getString(reference, 'type') !== 'image') {
      continue;
    }
    const imageUrl = getImageUrlFromReference(reference, sourceUrl);
    if (imageUrl) {
      candidates.push({
        url: imageUrl,
        alt: getString(reference, 'alt') ?? getString(reference, 'title'),
      });
    }
  }

  collectImageCandidatesFromContent(getArray(documentRecord.primaryContentSections), references, sourceUrl, candidates);
  collectImageCandidatesFromContent(getArray(documentRecord.sections), references, sourceUrl, candidates);
  return candidates;
}

function collectImageCandidatesFromContent(
  nodes: unknown[],
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
  candidates: DesignImageCandidate[],
): void {
  for (const node of nodes) {
    const record = asRecord(node);
    if (!record) {
      continue;
    }

    const type = getString(record, 'type');
    if (type === 'image' || type === 'icon') {
      const imageUrl = resolveImageBlockUrl(record, references, sourceUrl);
      if (imageUrl) {
        candidates.push({
          url: imageUrl,
          alt: getString(record, 'alt') ?? getString(record, 'title'),
        });
      }
    }

    for (const nestedKey of ['content', 'items', 'rows', 'cells', 'inlineContent']) {
      collectImageCandidatesFromContent(getArray(record[nestedKey]), references, sourceUrl, candidates);
    }
  }
}

function extractImageCandidatesFromHtml(html: string, sourceUrl: string): DesignImageCandidate[] {
  const $ = cheerio.load(html);
  const candidates: DesignImageCandidate[] = [];
  $('main img, body img').each((_index, element) => {
    const image = $(element);
    const imageUrl = normalizeUrl(image.attr('src') ?? image.attr('data-src'), sourceUrl);
    if (!imageUrl) {
      return;
    }
    candidates.push({
      url: imageUrl,
      alt: image.attr('alt') ?? undefined,
    });
  });
  return candidates;
}

function dedupeImageCandidates(candidates: DesignImageCandidate[]): DesignImageCandidate[] {
  const seenUrls = new Set<string>();
  const dedupedCandidates: DesignImageCandidate[] = [];
  for (const candidate of candidates) {
    if (seenUrls.has(candidate.url)) {
      continue;
    }
    seenUrls.add(candidate.url);
    dedupedCandidates.push(candidate);
  }
  return dedupedCandidates;
}

function parseDesignResourceItem(
  $: cheerio.CheerioAPI,
  item: cheerio.Cheerio<any>,
  category: string,
  platform: string | undefined,
  sourceUrl: string,
  seenResourceIds: Map<string, number>,
): DesignResourceCatalogEntry[] {
  const title = normalizeWhitespace(item.find('h5, h4, h3').first().text()) || category;
  const previewImageUrl = normalizeUrl(
    item.find('img.download-image, img').first().attr('src'),
    sourceUrl,
  );
  const noteParts = item.find('.download-text-description').map((_index, element) => {
    return normalizeWhitespace($(element).text());
  }).get().filter(Boolean);
  const note = noteParts.join(' ') || undefined;
  const relatedGuidelineLinks = item.find('a[href*="/design/human-interface-guidelines"]').map((_index, element) => {
    return normalizeUrl($(element).attr('href'), sourceUrl);
  }).get().filter((link): link is string => Boolean(link));
  const links = item.find('a[href]');
  const entries: DesignResourceCatalogEntry[] = [];
  const seenLinks = new Set<string>();

  links.each((_index, element) => {
    const link = $(element);
    const href = link.attr('href');
    const label = normalizeWhitespace(link.text()) || 'Download';
    if (!href || !isResourceCatalogLink(link, href, label)) {
      return;
    }

    const downloadUrl = normalizeUrl(href, sourceUrl);
    if (!downloadUrl) {
      return;
    }

    const linkKey = `${label}:${downloadUrl}`;
    if (seenLinks.has(linkKey)) {
      return;
    }
    seenLinks.add(linkKey);

    const format = inferFormat(downloadUrl, label);
    const resourceId = createResourceId(category, platform, label, seenResourceIds);
    entries.push({
      resourceId,
      category,
      platform: platform || undefined,
      title,
      downloadLabel: label,
      downloadUrl,
      format,
      note,
      previewImageUrl,
      relatedGuidelineLinks: [...new Set(relatedGuidelineLinks)],
    });
  });

  return entries;
}

function formatDesignContentSection(
  section: Record<string, unknown>,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
  defaultHeadingLevel: number,
): string {
  let content = '';
  const title = getString(section, 'title');
  if (title) {
    content += `${'#'.repeat(defaultHeadingLevel)} ${title}\n\n`;
  }

  const blocks = getArray(section.content);
  for (const block of blocks) {
    content += formatDesignBlock(block, references, sourceUrl, defaultHeadingLevel);
  }

  return content;
}

function formatSecondarySection(
  section: Record<string, unknown>,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
): string {
  const title = getString(section, 'title') ?? '';
  const kind = getString(section, 'kind') ?? '';
  const isChangeLog = `${title} ${kind}`.toLowerCase().includes('change');
  if (isChangeLog) {
    return formatChangeLogSection(section, references, sourceUrl);
  }

  return formatDesignContentSection(section, references, sourceUrl, 2);
}

function formatChangeLogSection(
  section: Record<string, unknown>,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
): string {
  let content = '## Change Log\n\n';
  const items = getRecordArray(section.items);
  for (const item of items) {
    const date = getString(item, 'date') ?? getString(item, 'title');
    if (date) {
      content += `### ${date}\n\n`;
    }
    for (const block of getArray(item.content)) {
      content += formatDesignBlock(block, references, sourceUrl, 4);
    }
  }
  return content;
}

function formatTopicSections(
  topicSections: Record<string, unknown>[],
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
): string {
  let content = '## Topics\n\n';
  for (const section of topicSections) {
    const title = getString(section, 'title');
    if (title) {
      content += `### ${title}\n\n`;
    }

    for (const identifier of getStringArray(section.identifiers)) {
      const reference = references.get(identifier);
      if (!reference) {
        continue;
      }
      const referenceTitle = getString(reference, 'title') ?? getIdentifierTitle(identifier);
      const referenceUrl = normalizeReferenceUrl(reference, sourceUrl);
      const abstractText = renderInlineCollection(getArray(reference.abstract), references, sourceUrl);
      if (referenceUrl) {
        content += `- [${referenceTitle}](${referenceUrl})`;
      } else {
        content += `- ${referenceTitle}`;
      }
      if (abstractText) {
        content += `: ${abstractText}`;
      }
      content += '\n';
    }
    content += '\n';
  }
  return content;
}

function formatDesignBlock(
  block: unknown,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
  headingLevel: number,
): string {
  const record = asRecord(block);
  if (!record) {
    return '';
  }

  const type = getString(record, 'type') ?? getString(record, 'kind');
  if (type === 'heading') {
    const level = getNumber(record, 'level') ?? headingLevel;
    const text = getString(record, 'text') ?? renderInlineCollection(getArray(record.inlineContent), references, sourceUrl);
    return text ? `${'#'.repeat(Math.min(level, 6))} ${text}\n\n` : '';
  }

  if (type === 'paragraph') {
    const text = renderInlineCollection(getArray(record.inlineContent), references, sourceUrl);
    return text ? `${text}\n\n` : '';
  }

  if (type === 'image' || type === 'icon') {
    const imageUrl = resolveImageBlockUrl(record, references, sourceUrl);
    if (!imageUrl) {
      return '';
    }
    const altText = resolveImageAltText(record, references) ?? 'Apple Design image';
    return `![${altText}](${imageUrl})\n\n`;
  }

  if (type === 'unorderedList' || type === 'orderedList') {
    return formatListBlock(record, references, sourceUrl, type === 'orderedList');
  }

  if (type === 'table') {
    return formatTableBlock(record, references, sourceUrl);
  }

  if (type === 'aside' || type === 'alert') {
    const blocks = getArray(record.content);
    const asideText = blocks.map(item => formatDesignBlock(item, references, sourceUrl, headingLevel + 1).trim())
      .filter(Boolean)
      .join('\n\n');
    return asideText ? `> ${asideText.replaceAll('\n', '\n> ')}\n\n` : '';
  }

  if (type === 'links' || type === 'linkGrid') {
    return formatLinksBlock(record, references, sourceUrl);
  }

  if (type === 'tabNavigator' || type === 'tabs') {
    return formatTabsBlock(record, references, sourceUrl, headingLevel);
  }

  if (type === 'reference') {
    const identifier = getString(record, 'identifier');
    if (!identifier) {
      return '';
    }
    const reference = references.get(identifier);
    const referenceTitle = reference ? getString(reference, 'title') : undefined;
    const referenceUrl = reference ? normalizeReferenceUrl(reference, sourceUrl) : undefined;
    if (referenceTitle && referenceUrl) {
      return `- [${referenceTitle}](${referenceUrl})\n\n`;
    }
  }

  const nestedContent = getArray(record.content);
  if (nestedContent.length > 0) {
    return nestedContent.map(item => formatDesignBlock(item, references, sourceUrl, headingLevel)).join('');
  }

  return renderInlineCollection(getArray(record.inlineContent), references, sourceUrl);
}

function formatListBlock(
  block: Record<string, unknown>,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
  ordered: boolean,
): string {
  let content = '';
  const items = getArray(block.items);
  items.forEach((item, index) => {
    const itemRecord = asRecord(item);
    if (!itemRecord) {
      return;
    }

    const itemContent = getArray(itemRecord.content)
      .map(contentBlock => formatDesignBlock(contentBlock, references, sourceUrl, 4).trim())
      .filter(Boolean)
      .join(' ');
    if (itemContent) {
      content += `${ordered ? `${index + 1}.` : '-'} ${itemContent}\n`;
    }
  });

  return content ? `${content}\n` : '';
}

function formatTableBlock(
  block: Record<string, unknown>,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
): string {
  const headerCells = getArray(block.header).map(cell => renderTableCell(cell, references, sourceUrl));
  const rows = getRecordArray(block.rows);
  if (headerCells.length === 0 || rows.length === 0) {
    return '';
  }

  let content = `| ${headerCells.join(' | ')} |\n`;
  content += `| ${headerCells.map(() => '---').join(' | ')} |\n`;
  for (const row of rows) {
    const cells = getArray(row.cells).map(cell => renderTableCell(cell, references, sourceUrl));
    content += `| ${cells.join(' | ')} |\n`;
  }
  return `${content}\n`;
}

function formatLinksBlock(
  block: Record<string, unknown>,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
): string {
  let content = '';
  for (const identifier of getStringArray(block.identifiers)) {
    const reference = references.get(identifier);
    if (!reference) {
      continue;
    }
    const title = getString(reference, 'title') ?? getIdentifierTitle(identifier);
    const url = normalizeReferenceUrl(reference, sourceUrl);
    if (url) {
      content += `- [${title}](${url})\n`;
    }
  }

  const links = getRecordArray(block.links);
  for (const link of links) {
    const title = getString(link, 'title') ?? renderInlineCollection(getArray(link.inlineContent), references, sourceUrl);
    const url = normalizeUrl(getString(link, 'url'), sourceUrl);
    if (title && url) {
      content += `- [${title}](${url})\n`;
    }
  }

  return content ? `${content}\n` : '';
}

function formatTabsBlock(
  block: Record<string, unknown>,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
  headingLevel: number,
): string {
  let content = '';
  const tabs = getRecordArray(block.tabs);
  for (const tab of tabs) {
    const title = getString(tab, 'title');
    if (title) {
      content += `${'#'.repeat(Math.min(headingLevel + 1, 6))} ${title}\n\n`;
    }
    for (const tabBlock of getArray(tab.content)) {
      content += formatDesignBlock(tabBlock, references, sourceUrl, headingLevel + 2);
    }
  }
  return content;
}

function renderTableCell(
  cell: unknown,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
): string {
  const cellRecord = asRecord(cell);
  if (!cellRecord) {
    return '';
  }

  const inlineText = renderInlineCollection(getArray(cellRecord.inlineContent), references, sourceUrl);
  if (inlineText) {
    return inlineText.replaceAll('|', '\\|');
  }

  const blockText = getArray(cellRecord.content)
    .map(block => formatDesignBlock(block, references, sourceUrl, 4).trim())
    .join(' ');
  return blockText.replaceAll('|', '\\|');
}

function renderInlineCollection(
  inlineContent: unknown[],
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
): string {
  return inlineContent.map(item => renderInlineContent(item, references, sourceUrl)).join('');
}

function renderInlineContent(
  inline: unknown,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
): string {
  const record = asRecord(inline);
  if (!record) {
    return '';
  }

  const type = getString(record, 'type');
  if (type === 'text') {
    return getString(record, 'text') ?? '';
  }

  if (type === 'strong') {
    return `**${renderInlineCollection(getArray(record.inlineContent), references, sourceUrl)}**`;
  }

  if (type === 'emphasis') {
    return `*${renderInlineCollection(getArray(record.inlineContent), references, sourceUrl)}*`;
  }

  if (type === 'codeVoice' || type === 'code') {
    return `\`${getString(record, 'code') ?? getString(record, 'text') ?? ''}\``;
  }

  if (type === 'reference') {
    const identifier = getString(record, 'identifier');
    if (!identifier) {
      return '';
    }
    const reference = references.get(identifier);
    const title = getString(record, 'title') ?? getString(reference, 'title') ?? getIdentifierTitle(identifier);
    const url = reference ? normalizeReferenceUrl(reference, sourceUrl) : undefined;
    if (url) {
      return `[${title}](${url})`;
    }
    return title;
  }

  if (type === 'link') {
    const title = getString(record, 'title')
      ?? getString(record, 'text')
      ?? renderInlineCollection(getArray(record.inlineContent), references, sourceUrl);
    const url = normalizeUrl(getString(record, 'url'), sourceUrl);
    if (title && url) {
      return `[${title}](${url})`;
    }
    return title;
  }

  const nestedInlineContent = getArray(record.inlineContent);
  if (nestedInlineContent.length > 0) {
    return renderInlineCollection(nestedInlineContent, references, sourceUrl);
  }

  return getString(record, 'text') ?? '';
}

function getSupportedPlatforms(documentRecord: Record<string, unknown>): string[] {
  const customMetadata = getDesignCustomMetadata(documentRecord);
  const supportedPlatforms = customMetadata?.['supported-platforms'] ?? customMetadata?.supportedPlatforms;
  return getStringArray(supportedPlatforms);
}

function getCustomMetadataString(documentRecord: Record<string, unknown>, key: string): string | undefined {
  const customMetadata = getDesignCustomMetadata(documentRecord);
  return getString(customMetadata, key);
}

function getDesignCustomMetadata(
  documentRecord: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const rootCustomMetadata = asRecord(documentRecord.customMetadata);
  if (rootCustomMetadata) {
    return rootCustomMetadata;
  }

  const metadata = asRecord(documentRecord.metadata);
  return asRecord(metadata?.customMetadata);
}

function resolveImageBlockUrl(
  block: Record<string, unknown>,
  references: Map<string, Record<string, unknown>>,
  sourceUrl: string,
): string | undefined {
  const directUrl = normalizeUrl(getString(block, 'url') ?? getString(block, 'source'), sourceUrl);
  if (directUrl) {
    return directUrl;
  }

  const identifier = getString(block, 'identifier');
  if (!identifier) {
    return undefined;
  }

  const reference = references.get(identifier);
  if (!reference) {
    return undefined;
  }

  return getImageUrlFromReference(reference, sourceUrl);
}

function resolveImageAltText(
  block: Record<string, unknown>,
  references: Map<string, Record<string, unknown>>,
): string | undefined {
  const directAlt = getString(block, 'alt') ?? getString(block, 'title');
  if (directAlt) {
    return directAlt;
  }

  const identifier = getString(block, 'identifier');
  if (!identifier) {
    return undefined;
  }

  const reference = references.get(identifier);
  return getString(reference, 'alt') ?? getString(reference, 'title');
}

function getImageUrlFromReference(
  reference: Record<string, unknown>,
  sourceUrl: string,
): string | undefined {
  const directUrl = normalizeUrl(getString(reference, 'url'), sourceUrl);
  if (directUrl && isDirectImageUrl(directUrl)) {
    return directUrl;
  }

  const variants = getRecordArray(reference.variants);
  for (const variant of variants) {
    const variantUrl = normalizeUrl(getString(variant, 'url'), sourceUrl);
    if (variantUrl) {
      return variantUrl;
    }
  }

  const images = getRecordArray(reference.images);
  for (const image of images) {
    const imageUrl = normalizeUrl(getString(image, 'url'), sourceUrl);
    if (imageUrl) {
      return imageUrl;
    }
  }

  return undefined;
}

function normalizeReferenceUrl(
  reference: Record<string, unknown> | undefined,
  sourceUrl: string,
): string | undefined {
  if (!reference) {
    return undefined;
  }

  const referenceUrl = getString(reference, 'url');
  return normalizeUrl(referenceUrl, sourceUrl);
}

function updateResourceCatalogIndex(resources: DesignResourceCatalogEntry[]): void {
  for (const resource of resources) {
    resourceCatalogById.set(resource.resourceId, resource);
  }
}

function isResourceCatalogLink(
  link: cheerio.Cheerio<any>,
  href: string,
  label: string,
): boolean {
  if (link.hasClass('download-text-link')) {
    return true;
  }

  if (href.startsWith('sketch://') || href.includes('figma.com')) {
    return true;
  }

  const parsedUrl = safeUrl(href);
  const pathname = parsedUrl?.pathname ?? href;
  const extension = path.extname(pathname).toLowerCase();
  if (DIRECT_RESOURCE_EXTENSIONS.has(extension)) {
    return true;
  }

  const normalizedLabel = label.toLowerCase();
  return normalizedLabel.includes('download')
    || normalizedLabel.includes('figma')
    || normalizedLabel.includes('sketch');
}

function createResourceId(
  category: string,
  platform: string | undefined,
  label: string,
  seenResourceIds: Map<string, number>,
): string {
  const baseId = [
    'design-resource',
    slugify(category),
    slugify(platform || 'all'),
    slugify(label),
  ].join(':');
  const seenCount = seenResourceIds.get(baseId) ?? 0;
  seenResourceIds.set(baseId, seenCount + 1);
  if (seenCount === 0) {
    return baseId;
  }
  return `${baseId}:${seenCount + 1}`;
}

function findNearestHeadingText(
  $: cheerio.CheerioAPI,
  item: cheerio.Cheerio<any>,
): string | undefined {
  const previousHeading = item.prevAll('h4, h3').first();
  if (previousHeading.length > 0) {
    return normalizeWhitespace(previousHeading.text());
  }

  const parentPreviousHeading = item.parent().prevAll('h4, h3').first();
  if (parentPreviousHeading.length > 0) {
    return normalizeWhitespace(parentPreviousHeading.text());
  }

  const sectionHeading = item.closest('section').find('h4, h3').first();
  const headingText = normalizeWhitespace($(sectionHeading).text());
  return headingText || undefined;
}

function normalizeUrl(url: string | undefined, sourceUrl: string): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url, sourceUrl).toString();
  } catch {
    return undefined;
  }
}

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isDesignResourcesUrl(url: string): boolean {
  const parsedUrl = safeUrl(url);
  return parsedUrl?.hostname === 'developer.apple.com' && parsedUrl.pathname.startsWith('/design/resources');
}

function isDirectAppleDownloadUrl(url: string): boolean {
  const parsedUrl = safeUrl(url);
  return Boolean(parsedUrl && parsedUrl.protocol === 'https:' && APPLE_DESIGN_DOWNLOAD_HOSTS.has(parsedUrl.hostname));
}

function validateDownloadUrl(url: string): void {
  const parsedUrl = safeUrl(url);
  if (!parsedUrl || parsedUrl.protocol !== 'https:') {
    throw new Error('Apple Design downloads must use HTTPS URLs.');
  }

  if (!APPLE_DESIGN_DOWNLOAD_HOSTS.has(parsedUrl.hostname)) {
    throw new Error(`Download domain is not allowed: ${parsedUrl.hostname}`);
  }
}

function isDirectImageUrl(url: string): boolean {
  const mimeType = detectMimeType(undefined, url);
  return isImageMimeType(mimeType);
}

function inferFormat(url: string, label: string): string {
  const normalizedLabel = label.toLowerCase();
  if (normalizedLabel.includes('figma') || url.includes('figma.com')) {
    return 'figma';
  }
  if (normalizedLabel.includes('sketch') || url.startsWith('sketch://')) {
    return 'sketch';
  }

  const parsedUrl = safeUrl(url);
  const extension = path.extname(parsedUrl?.pathname ?? url).replace('.', '').toLowerCase();
  if (extension) {
    return extension;
  }

  return 'external';
}

function detectMimeType(contentType: string | null | undefined, url: string): string {
  if (contentType) {
    return contentType.split(';')[0].trim().toLowerCase();
  }

  const parsedUrl = safeUrl(url);
  const extension = path.extname(parsedUrl?.pathname ?? url).toLowerCase();
  switch (extension) {
    case '.dmg':
      return 'application/x-apple-diskimage';
    case '.gif':
      return 'image/gif';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith(IMAGE_MIME_PREFIX);
}

function getContentLength(response: Response): number | undefined {
  const contentLengthHeader = response.headers.get('content-length');
  if (!contentLengthHeader) {
    return undefined;
  }

  const contentLength = Number.parseInt(contentLengthHeader, 10);
  if (Number.isNaN(contentLength)) {
    return undefined;
  }
  return contentLength;
}

function getDesignCacheDirectory(): string {
  return process.env.APPLE_DOCS_MCP_CACHE_DIR
    || path.join(tmpdir(), 'apple-docs-mcp', 'design-resources');
}

function createTextContent(text: string): ContentBlock {
  return {
    type: 'text',
    text,
  };
}

function createResourceLink(cachedResource: CachedDesignResource): ResourceLink {
  return {
    type: 'resource_link',
    uri: cachedResource.uri,
    name: cachedResource.name,
    title: cachedResource.title,
    description: cachedResource.description,
    mimeType: cachedResource.mimeType,
  };
}

function containsText(source: string | undefined, query: string): boolean {
  if (!source) {
    return false;
  }
  return source.toLowerCase().includes(query.toLowerCase());
}

function resourceMatchesPlatform(resource: DesignResourceCatalogEntry, platform: string): boolean {
  if (platform === 'all') {
    return true;
  }
  return containsText(resource.platform, platform) || containsText(resource.title, platform);
}

function getFilenameFromUrl(url: string): string {
  const parsedUrl = safeUrl(url);
  const basename = path.basename(parsedUrl?.pathname ?? url);
  return basename || 'apple-design-resource';
}

function sanitizeFilename(filename: string): string {
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '-');
  return sanitizedFilename || 'apple-design-resource';
}

function slugify(value: string): string {
  const slug = value.toLowerCase()
    .replaceAll('&', 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'resource';
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function getIdentifierTitle(identifier: string): string {
  return identifier.split('/').pop() ?? identifier;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function getRecordMap(value: unknown): Map<string, Record<string, unknown>> {
  const valueRecord = asRecord(value);
  const map = new Map<string, Record<string, unknown>>();
  if (!valueRecord) {
    return map;
  }

  for (const [key, entryValue] of Object.entries(valueRecord)) {
    const entryRecord = asRecord(entryValue);
    if (entryRecord) {
      map.set(key, entryRecord);
    }
  }

  return map;
}

function getRecordArray(value: unknown): Record<string, unknown>[] {
  return getArray(value).flatMap(item => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }
    return [record];
  });
}

function getArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function getString(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const propertyValue = record[key];
  if (typeof propertyValue === 'string') {
    return propertyValue;
  }
  return undefined;
}

function getNumber(value: unknown, key: string): number | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const propertyValue = record[key];
  if (typeof propertyValue === 'number') {
    return propertyValue;
  }
  return undefined;
}

function getStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  if (typeof value === 'string') {
    return [value];
  }

  return [];
}

export async function removeCachedDesignResourcesForTesting(): Promise<void> {
  const cacheDirectory = getDesignCacheDirectory();
  await rm(cacheDirectory, {
    force: true,
    recursive: true,
  });
}
