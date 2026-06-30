import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearDesignResourceCacheForTesting,
  formatAppleDesignDocument,
  handleDownloadAppleDesignResource,
  handleGetAppleDesignExamples,
  listCachedDesignResources,
  parseAppleDesignHtmlPage,
  parseDesignResourcesHtml,
  readCachedDesignResource,
} from '../../src/tools/design-docs.js';
import { httpClient } from '../../src/utils/http-client.js';

jest.mock('../../src/utils/http-client.js', () => ({
  httpClient: {
    get: jest.fn(),
    getJson: jest.fn(),
    getText: jest.fn(),
  },
}));

const SAMPLE_HIG_DOCUMENT = {
  metadata: {
    title: 'Layout',
    role: 'article',
    abstract: [
      {
        type: 'text',
        text: 'Place content in ways that help people understand your interface.',
      },
    ],
    customMetadata: {
      'supported-platforms': [
        'iOS',
        'iPadOS',
        'macOS',
      ],
      'alert-text': 'Use layout guidance with platform conventions.',
      'alert-date': '2026-06-09',
    },
  },
  abstract: [
    {
      type: 'text',
      text: 'Arrange views so people can understand and interact with them.',
    },
  ],
  references: {
    'doc://image/layout-hero': {
      type: 'image',
      alt: 'A layout example',
      variants: [
        {
          url: '/assets/elements/icons/layout-hero.png',
        },
      ],
    },
    'doc://topic/color': {
      title: 'Color',
      url: '/design/human-interface-guidelines/color',
      abstract: [
        {
          type: 'text',
          text: 'Use color consistently.',
        },
      ],
    },
  },
  primaryContentSections: [
    {
      kind: 'content',
      content: [
        {
          type: 'heading',
          text: 'Best practices',
          level: 2,
        },
        {
          type: 'paragraph',
          inlineContent: [
            {
              type: 'text',
              text: 'Use a ',
            },
            {
              type: 'strong',
              inlineContent: [
                {
                  type: 'text',
                  text: 'consistent',
                },
              ],
            },
            {
              type: 'text',
              text: ' grid.',
            },
          ],
        },
        {
          type: 'image',
          identifier: 'doc://image/layout-hero',
        },
        {
          type: 'unorderedList',
          items: [
            {
              content: [
                {
                  type: 'paragraph',
                  inlineContent: [
                    {
                      type: 'text',
                      text: 'Align related controls.',
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'table',
          header: [
            {
              inlineContent: [
                {
                  type: 'text',
                  text: 'Platform',
                },
              ],
            },
            {
              inlineContent: [
                {
                  type: 'text',
                  text: 'Spacing',
                },
              ],
            },
          ],
          rows: [
            {
              cells: [
                {
                  inlineContent: [
                    {
                      type: 'text',
                      text: 'iOS',
                    },
                  ],
                },
                {
                  inlineContent: [
                    {
                      type: 'text',
                      text: '8 pt',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  topicSections: [
    {
      title: 'Foundations',
      identifiers: [
        'doc://topic/color',
      ],
    },
  ],
  sections: [
    {
      title: 'Change log',
      kind: 'changes',
      items: [
        {
          date: '2026-06-09',
          content: [
            {
              type: 'paragraph',
              inlineContent: [
                {
                  type: 'text',
                  text: 'Updated platform guidance.',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const SAMPLE_RESOURCES_HTML = `
  <main>
    <section class="section-download">
      <h2>Design templates</h2>
      <h4>iOS 18 and iPadOS 18</h4>
      <div class="grid-item">
        <img class="download-image" src="/assets/elements/icons/ios-template.png" alt="iOS template">
        <h5>iOS 18 and iPadOS 18</h5>
        <a class="download-text-link" href="https://www.figma.com/community/file/123">Figma</a>
        <a class="download-text-link" href="sketch://add-library?url=https://example.com/library.sketch">Sketch Library</a>
        <a class="download-text-link" href="/design/downloads/iOS-18.dmg">Download</a>
        <p class="download-text-description">Requires macOS Sonoma or later.</p>
        <p class="download-text-description"><a href="/design/human-interface-guidelines/layout">Layout</a></p>
      </div>
    </section>
    <section class="section-download">
      <h2>Fonts</h2>
      <h4>System fonts</h4>
      <div class="grid-item">
        <img class="download-image" src="https://docs-assets.developer.apple.com/fonts.png" alt="">
        <h5>SF Pro</h5>
        <a class="download-text-link" href="https://developer.apple.com/fonts/SF-Pro.zip">Download</a>
      </div>
    </section>
  </main>
`;

let temporaryCacheDirectory: string | undefined;

function createResponse(
  data: Buffer,
  contentType: string | undefined,
  contentLength?: number,
): Response {
  const headers = new Headers();
  if (contentType) {
    headers.set('content-type', contentType);
  }
  if (contentLength !== undefined) {
    headers.set('content-length', String(contentLength));
  } else {
    headers.set('content-length', String(data.length));
  }

  return new Response(data, {
    status: 200,
    headers,
  });
}

beforeEach(async () => {
  temporaryCacheDirectory = await mkdtemp(path.join(tmpdir(), 'apple-design-test-'));
  process.env.APPLE_DOCS_MCP_CACHE_DIR = temporaryCacheDirectory;
  clearDesignResourceCacheForTesting();
  jest.clearAllMocks();
});

afterEach(async () => {
  clearDesignResourceCacheForTesting();
  delete process.env.APPLE_DOCS_MCP_CACHE_DIR;

  if (temporaryCacheDirectory) {
    await rm(temporaryCacheDirectory, {
      force: true,
      recursive: true,
    });
  }
});

describe('Apple Design document formatting', () => {
  it('should format HIG JSON content with images, tables, links, platforms, and change logs', () => {
    const result = formatAppleDesignDocument(
      SAMPLE_HIG_DOCUMENT,
      'https://developer.apple.com/design/human-interface-guidelines/layout',
    );

    expect(result).toContain('# Layout');
    expect(result).toContain('Arrange views so people can understand and interact with them.');
    expect(result).toContain('## Supported Platforms');
    expect(result).toContain('iOS');
    expect(result).toContain('## Alert');
    expect(result).toContain('Use layout guidance with platform conventions.');
    expect(result).toContain('**consistent** grid.');
    expect(result).toContain('![A layout example](https://developer.apple.com/assets/elements/icons/layout-hero.png)');
    expect(result).toContain('| Platform | Spacing |');
    expect(result).toContain('- [Color](https://developer.apple.com/design/human-interface-guidelines/color)');
    expect(result).toContain('## Change Log');
    expect(result).toContain('2026-06-09');
  });

  it('should parse Apple Design HTML cards when JSON is not available', () => {
    const html = `
      <main>
        <h1>Apple Design</h1>
        <p>Design great apps and games.</p>
        <a class="tile" href="/design/resources/">
          <h3>Design resources</h3>
          <p>Download templates, components, and tools.</p>
        </a>
      </main>
    `;

    const result = parseAppleDesignHtmlPage(html, 'https://developer.apple.com/design/');

    expect(result).toContain('# Apple Design');
    expect(result).toContain('Design great apps and games.');
    expect(result).toContain('[Design resources](https://developer.apple.com/design/resources/)');
  });
});

describe('Apple Design Resources parser', () => {
  it('should extract templates, fonts, notes, previews, formats, and related HIG links', () => {
    const resources = parseDesignResourcesHtml(
      SAMPLE_RESOURCES_HTML,
      'https://developer.apple.com/design/resources/',
    );

    expect(resources).toHaveLength(4);
    expect(resources[0]).toMatchObject({
      resourceId: 'design-resource:design-templates:ios-18-and-ipados-18:figma',
      category: 'Design templates',
      platform: 'iOS 18 and iPadOS 18',
      title: 'iOS 18 and iPadOS 18',
      format: 'figma',
      downloadLabel: 'Figma',
      downloadUrl: 'https://www.figma.com/community/file/123',
      note: 'Requires macOS Sonoma or later. Layout',
      previewImageUrl: 'https://developer.apple.com/assets/elements/icons/ios-template.png',
    });
    expect(resources[0].relatedGuidelineLinks).toEqual([
      'https://developer.apple.com/design/human-interface-guidelines/layout',
    ]);
    expect(resources[1]).toMatchObject({
      format: 'sketch',
      downloadUrl: 'sketch://add-library?url=https://example.com/library.sketch',
    });
    expect(resources[2]).toMatchObject({
      format: 'dmg',
      downloadUrl: 'https://developer.apple.com/design/downloads/iOS-18.dmg',
    });
    expect(resources[3]).toMatchObject({
      category: 'Fonts',
      format: 'zip',
      title: 'SF Pro',
    });
  });
});

describe('Apple Design downloads and resources', () => {
  it('should download direct images, return image content, and expose BlobResourceContents', async () => {
    const imageBytes = Buffer.from('image-bytes');
    (httpClient.get as jest.Mock).mockResolvedValue(
      createResponse(imageBytes, 'image/png'),
    );

    const result = await handleDownloadAppleDesignResource({
      url: 'https://developer.apple.com/design/images/example.png',
    });

    const imageContent = result.content.find(content => content.type === 'image');
    const resourceLink = result.content.find(content => content.type === 'resource_link');

    expect(imageContent).toMatchObject({
      type: 'image',
      data: imageBytes.toString('base64'),
      mimeType: 'image/png',
    });
    expect(resourceLink).toMatchObject({
      type: 'resource_link',
      mimeType: 'image/png',
      name: 'example.png',
    });

    const resources = await listCachedDesignResources();
    expect(resources.resources).toHaveLength(1);

    const resource = await readCachedDesignResource(resourceLink?.uri ?? '');
    expect(resource.contents[0]).toMatchObject({
      uri: resourceLink?.uri,
      mimeType: 'image/png',
      blob: imageBytes.toString('base64'),
    });
  });

  it('should return resource links for non-image downloads with MIME fallback', async () => {
    const archiveBytes = Buffer.from('zip-bytes');
    (httpClient.get as jest.Mock).mockResolvedValue(
      createResponse(archiveBytes, undefined),
    );

    const result = await handleDownloadAppleDesignResource({
      url: 'https://developer.apple.com/design/downloads/templates.zip',
    });

    expect(result.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Downloaded Apple Design resource'),
      }),
      expect.objectContaining({
        type: 'resource_link',
        mimeType: 'application/zip',
        name: 'templates.zip',
      }),
    ]);
  });

  it('should reject blocked download domains', async () => {
    await expect(handleDownloadAppleDesignResource({
      url: 'https://example.com/design-kit.zip',
    })).rejects.toThrow('not allowed');
  });

  it('should reject oversized downloads before reading the body', async () => {
    const archiveBytes = Buffer.from('zip-bytes');
    (httpClient.get as jest.Mock).mockResolvedValue(
      createResponse(archiveBytes, 'application/zip', 11),
    );

    await expect(handleDownloadAppleDesignResource({
      url: 'https://developer.apple.com/design/downloads/templates.zip',
      maxBytes: 10,
    })).rejects.toThrow('exceeds');
  });

  it('should reuse duplicate cache hits for the same URL', async () => {
    const archiveBytes = Buffer.from('zip-bytes');
    (httpClient.get as jest.Mock).mockResolvedValue(
      createResponse(archiveBytes, 'application/zip'),
    );

    const firstResult = await handleDownloadAppleDesignResource({
      url: 'https://developer.apple.com/design/downloads/templates.zip',
    });
    const secondResult = await handleDownloadAppleDesignResource({
      url: 'https://developer.apple.com/design/downloads/templates.zip',
    });

    const firstLink = firstResult.content.find(content => content.type === 'resource_link');
    const secondLink = secondResult.content.find(content => content.type === 'resource_link');

    expect(httpClient.get).toHaveBeenCalledTimes(1);
    expect(firstLink?.uri).toBe(secondLink?.uri);
  });
});

describe('Apple Design examples', () => {
  it('should return HIG image references as MCP image content blocks', async () => {
    const imageBytes = Buffer.from('hig-image');
    (httpClient.getJson as jest.Mock).mockResolvedValue(SAMPLE_HIG_DOCUMENT);
    (httpClient.get as jest.Mock).mockResolvedValue(
      createResponse(imageBytes, 'image/png'),
    );

    const result = await handleGetAppleDesignExamples({
      url: 'https://developer.apple.com/design/human-interface-guidelines/layout',
      limit: 1,
    });

    expect(result.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Apple Design Examples'),
      }),
      expect.objectContaining({
        type: 'image',
        data: imageBytes.toString('base64'),
        mimeType: 'image/png',
      }),
    ]);
  });
});
