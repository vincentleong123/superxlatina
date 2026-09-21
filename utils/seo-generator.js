const { durToIso } = require('./seo-layer');

class SEOGenerator {
  constructor(opts) {
    this.siteName = opts.siteName || 'Super X Latina';
    this.siteUrl = opts.siteUrl || 'https://superxlatina.com';
    this.socialMedia = opts.socialMedia || {};
  }

  generateStructuredData(type, data) {
    switch (type) {
      case 'organization':
        return '<script type="application/ld+json">' + JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: this.siteName,
          alternateName: 'Super X Latina',
          description: 'Premium HD latina video collection.',
          url: this.siteUrl,
          logo: this.siteUrl + '/favicon.png',
          sameAs: Object.values(this.socialMedia).filter(Boolean),
          knowsAbout: ['Latina videos', 'Latina', 'HD latina', 'Uncensored latina']
        }) + '</script>';

      case 'video':
        if (!data) return '';
        return '<script type="application/ld+json">' + JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'VideoObject',
          name: data.title,
          description: data.description?.replace(/<[^>]+>/g, '').substring(0, 300) || 'Watch ' + data.title,
          thumbnailUrl: data.thumbnail ? [data.thumbnail.startsWith('http') ? data.thumbnail : this.siteUrl + data.thumbnail] : undefined,
          uploadDate: data.uploaded || new Date().toISOString(),
          contentUrl: this.siteUrl + data.video,
          embedUrl: this.siteUrl + '/' + data.id,
          duration: durToIso(data.duration),
          interactionStatistic: data.views ? {
            '@type': 'InteractionCounter',
            interactionType: 'WatchAction',
            userInteractionCount: data.views
          } : undefined,
          about: {
            '@type': 'Thing',
            name: 'Latina Video',
            description: 'Premium HD latina video content'
          },
          audience: {
            '@type': 'Audience',
            audienceType: 'Adult viewers'
          }
        }) + '</script>';

      case 'collection':
        if (!data) return '';
        return '<script type="application/ld+json">' + JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: data.name || this.siteName,
          description: data.description || 'Premium HD latina video collection',
          url: this.siteUrl,
          about: {
            '@type': 'Thing',
            name: 'Latina Videos',
            description: 'Premium HD latina video content'
          },
          audience: {
            '@type': 'Audience',
            audienceType: 'Adult viewers'
          }
        }) + '</script>';

      case 'breadcrumb':
        if (!data?.items) return '';
        return '<script type="application/ld+json">' + JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: data.items.map((item, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: item.name,
            item: item.url
          }))
        }) + '</script>';

      case 'website':
        return '<script type="application/ld+json">' + JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: this.siteName,
          url: this.siteUrl,
          potentialAction: {
            '@type': 'SearchAction',
            target: this.siteUrl + '/?q={search_term_string}',
            'query-input': 'required name=search_term_string'
          }
        }) + '</script>';

      default:
        return '';
    }
  }

  generateSitemapEntry({ permalink, updated, changefreq, priority }) {
    return `<url><loc>${permalink}</loc><lastmod>${updated || new Date().toISOString().split('T')[0]}</lastmod><changefreq>${changefreq || 'monthly'}</changefreq><priority>${priority || '0.7'}</priority></url>`;
  }

  generateVideoSitemapEntry({ permalink, title, description, contentLoc, thumbnailLoc, duration, uploadDate }) {
    return `<url><loc>${permalink}</loc><video:video><video:title><![CDATA[${title}]]></video:title><video:description><![CDATA[${description || ''}]]></video:description><video:content_loc>${contentLoc}</video:content_loc><video:thumbnail_loc>${thumbnailLoc}</video:thumbnail_loc>${duration ? '<video:duration>' + duration + '</video:duration>' : ''}<video:publication_date>${uploadDate || new Date().toISOString().split('T')[0]}</video:publication_date><video:family_friendly>true</video:family_friendly><video:category>Entertainment</video:category></video:video></url>`;
  }

  generateSocialMeta(title, desc, url, image) {
    return {
      ogTitle: title,
      ogDescription: desc,
      ogImage: image || '',
      ogUrl: url,
      twitterCard: 'summary_large_image',
      twitterTitle: title,
      twitterDescription: desc
    };
  }
}

module.exports = SEOGenerator;
