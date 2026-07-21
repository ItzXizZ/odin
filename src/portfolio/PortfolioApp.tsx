import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { PROFILE, PROJECTS, type GalleryItem, type Project } from './data'
import portrait from './assets/ethan-valedictorian-speech.jpg'
import cornellLogo from './assets/cornell-logo.svg'
import smusCrest from './assets/smus-crest.svg'
import './portfolio.css'

const ease = [0.22, 1, 0.36, 1] as const

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function GalleryCard({ item, span }: { item: GalleryItem; span: number }) {
  const inner = (
    <>
      <img src={item.src} alt={item.alt} loading="lazy" />
      {item.kind === 'press' ? (
        <div className="pf-gal-overlay pf-gal-overlay-press">
          <span className="pf-gal-outlet">{item.outlet}</span>
          <span className="pf-gal-headline">{item.headline}</span>
        </div>
      ) : (
        item.caption && (
          <div className="pf-gal-overlay">
            <span className="pf-gal-cap">{item.caption}</span>
          </div>
        )
      )}
    </>
  )

  const className = `pf-gal-card pf-gal-${item.kind} pf-gal-span-${span}`
  if (item.href) {
    return (
      <a className={className} href={item.href} target="_blank" rel="noreferrer">
        {inner}
      </a>
    )
  }
  return <div className={className}>{inner}</div>
}

/*
 * Lay gallery items out on a 12-column grid so every row is completely
 * filled — press features pair up two per row, everything else flows in
 * rows of up to four. This is what keeps the mosaic seamless.
 */
function layoutGallery(gallery: GalleryItem[]): { item: GalleryItem; span: number }[] {
  // One press + one product (or any pair) should sit on one row, not stack.
  if (gallery.length === 2) {
    return gallery.map((item) => ({ item, span: 6 }))
  }

  const press = gallery.filter((g) => g.kind === 'press')
  const rest = gallery.filter((g) => g.kind !== 'press')

  const placed: { item: GalleryItem; span: number }[] = []

  for (let i = 0; i < press.length; i += 2) {
    const pair = press.slice(i, i + 2)
    const span = pair.length === 2 ? 6 : 12
    pair.forEach((item) => placed.push({ item, span }))
  }

  const rowSizes: number[] = []
  let n = rest.length
  while (n > 0) {
    if (n === 5) {
      rowSizes.push(3, 2)
      n = 0
    } else if (n % 4 === 0) {
      rowSizes.push(4)
      n -= 4
    } else if (n % 3 === 0) {
      rowSizes.push(3)
      n -= 3
    } else if (n <= 4) {
      rowSizes.push(n)
      n = 0
    } else {
      rowSizes.push(4)
      n -= 4
    }
  }

  let idx = 0
  for (const size of rowSizes) {
    const span = 12 / size
    for (let i = 0; i < size; i += 1) {
      placed.push({ item: rest[idx], span })
      idx += 1
    }
  }

  return placed
}

/*
 * Variant used when a portrait demo video is woven into the mosaic:
 * the video occupies a 4-column, 2-row slot on the left, the next four
 * items fill the two rows beside it, and the rest flow below.
 */
function layoutGalleryWithVideo(gallery: GalleryItem[]): { item: GalleryItem; span: number }[] {
  const beside = gallery.slice(0, 4).map((item) => ({ item, span: 4 }))
  const below = layoutGallery(gallery.slice(4))
  return [...beside, ...below]
}

function Gallery({ gallery, videoSrc }: { gallery: GalleryItem[]; videoSrc?: string }) {
  const placed = videoSrc ? layoutGalleryWithVideo(gallery) : layoutGallery(gallery)
  return (
    <div className={`pf-gallery${videoSrc ? ' pf-gallery-feature' : ''}`}>
      {videoSrc && (
        <div className="pf-gal-card pf-gal-video">
          <video src={videoSrc} autoPlay muted loop playsInline preload="metadata" />
        </div>
      )}
      {placed.map(({ item, span }) => (
        <GalleryCard key={item.src + (item.headline || item.caption || item.alt)} item={item} span={span} />
      ))}
    </div>
  )
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="pf-bullets">
      {items.map((b) => (
        <li key={b}>{b}</li>
      ))}
    </ul>
  )
}

function MediaLinks({ media }: { media: Project['media'] }) {
  if (media.length === 0) return null
  return (
    <div className="pf-block-links">
      {media.map((m) => (
        <a key={m.href + m.label} href={m.href} target="_blank" rel="noreferrer">
          {m.label}
        </a>
      ))}
    </div>
  )
}

function ProjectVideo({ project }: { project: Project }) {
  const isPortrait = project.videoAspect === 'portrait'

  if (project.videoSrc) {
    return (
      <div className={`pf-block-video${isPortrait ? ' pf-block-video-portrait' : ''}`}>
        <video src={project.videoSrc} controls playsInline preload="metadata" />
      </div>
    )
  }

  if (project.videoEmbed) {
    // Muted, chromeless auto-loop — YouTube requires the playlist param
    // set to the video's own id for looping to work.
    const videoId = project.videoEmbed.split('/').pop()
    const src = `${project.videoEmbed}?autoplay=1&mute=1&loop=1&playlist=${videoId}&controls=0&playsinline=1&rel=0&modestbranding=1`
    return (
      <div className="pf-block-video">
        <iframe
          src={src}
          title={`${project.name} demo`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          loading="lazy"
        />
      </div>
    )
  }

  return null
}

function ProjectBlock({ project, index }: { project: Project; index: number }) {
  // Portrait demo videos with a rich gallery get woven into the mosaic
  // instead of sitting beside the copy (which leaves dead space).
  const videoInGallery = Boolean(
    project.videoSrc && project.videoAspect === 'portrait' && project.gallery.length >= 4,
  )
  const hasVideo = !videoInGallery && Boolean(project.videoEmbed || project.videoSrc)
  const isPortraitVideo = project.videoAspect === 'portrait'
  const galleryBelow =
    project.galleryBelow || videoInGallery || project.gallery.length > 2

  return (
    <motion.article
      className={`pf-block${hasVideo ? ' pf-block-has-video' : ''}`}
      id={project.id}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.45, ease, delay: Math.min(index * 0.03, 0.12) }}
    >
      <header className="pf-block-head">
        <span className="pf-block-num" aria-hidden>
          {String(index + 1).padStart(2, '0')}
        </span>
        <div className="pf-block-titles">
          <h3 className="pf-block-name">
            {project.name}
            {project.url && (
              <a className="pf-block-url" href={project.url} target="_blank" rel="noreferrer">
                {project.urlLabel ?? project.url}
              </a>
            )}
          </h3>
          <p className="pf-block-tag">{project.tagline}</p>
        </div>
      </header>

      {hasVideo ? (
        <>
          <div className={`pf-block-split${isPortraitVideo ? ' pf-block-split-portrait' : ''}`}>
            <div className="pf-block-video-wrap">
              <ProjectVideo project={project} />
            </div>
            <div className="pf-block-copy">
              <p className="pf-block-desc">{project.description}</p>
              <BulletList items={project.bullets} />
              <MediaLinks media={project.media} />
            </div>
          </div>
          {project.gallery.length > 0 && (
            <div className="pf-gallery-below">
              <Gallery gallery={project.gallery} />
            </div>
          )}
        </>
      ) : galleryBelow ? (
        <>
          <div className="pf-block-copy pf-block-copy-wide">
            <p className="pf-block-desc">{project.description}</p>
            <BulletList items={project.bullets} />
            <MediaLinks media={project.media} />
          </div>
          <div className="pf-gallery-below">
            <Gallery gallery={project.gallery} videoSrc={videoInGallery ? project.videoSrc : undefined} />
          </div>
        </>
      ) : (
        <div className="pf-block-body">
          <div className="pf-block-copy">
            <p className="pf-block-desc">{project.description}</p>
            <BulletList items={project.bullets} />
            <MediaLinks media={project.media} />
          </div>
          {project.gallery.length > 0 && <Gallery gallery={project.gallery} />}
        </div>
      )}
    </motion.article>
  )
}

function ValedictorianSpeech() {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [audioOn, setAudioOn] = useState(false)
  const videoId = PROFILE.valedictorianVideoId

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    const send = (func: string) => {
      iframe.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: '' }), '*')
    }

    const onLoad = () => {
      send(audioOn ? 'unMute' : 'mute')
    }

    iframe.addEventListener('load', onLoad)
    return () => iframe.removeEventListener('load', onLoad)
  }, [audioOn, videoId])

  const toggleAudio = () => {
    const next = !audioOn
    setAudioOn(next)
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func: next ? 'unMute' : 'mute', args: '' }),
      '*',
    )
  }

  const src = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&enablejsapi=1&playsinline=1&rel=0&modestbranding=1&origin=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin : '')}`

  return (
    <section className="pf-glass pf-vale" aria-label="Valedictorian speech">
      <div className="pf-vale-head">
        <div>
          <p className="pf-vale-kicker">SMUS &apos;26</p>
          <h2 className="pf-vale-title">Valedictorian speech</h2>
        </div>
        <button type="button" className="pf-btn pf-vale-audio" onClick={toggleAudio}>
          {audioOn ? 'Audio off' : 'Audio on'}
        </button>
      </div>
      <div className="pf-vale-video">
        <iframe
          ref={iframeRef}
          src={src}
          title="Ethan Curtis valedictorian speech"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          loading="lazy"
        />
      </div>
    </section>
  )
}

export default function PortfolioApp() {
  useEffect(() => {
    document.title = 'Ethan Curtis'
  }, [])

  return (
    <div className="pf">
      <div className="pf-orbs" aria-hidden>
        <div className="pf-orb pf-orb-a" />
        <div className="pf-orb pf-orb-b" />
        <div className="pf-orb pf-orb-c" />
      </div>

      <div className="pf-shell">
        <nav className="pf-nav">
          <a className="pf-nav-brand" href="#top">
            Ethan Curtis
          </a>
          <div className="pf-nav-links">
            <button type="button" className="pf-nav-link" onClick={() => scrollToId('work')}>
              Work
            </button>
            <button
              type="button"
              className="pf-nav-link pf-nav-cta"
              onClick={() => scrollToId('contact')}
            >
              Contact
            </button>
          </div>
        </nav>

        <header className="pf-hero" id="top">
          <motion.div
            className="pf-hero-copy"
            initial="hidden"
            animate="show"
            variants={{
              hidden: {},
              show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
            }}
          >
            <motion.p
              className="pf-kicker"
              variants={{
                hidden: { opacity: 0, y: 12 },
                show: { opacity: 1, y: 0, transition: { duration: 0.4, ease } },
              }}
            >
              {PROFILE.title}
            </motion.p>
            <motion.h1
              className="pf-name"
              variants={{
                hidden: { opacity: 0, y: 18 },
                show: { opacity: 1, y: 0, transition: { duration: 0.5, ease } },
              }}
            >
              Ethan Curtis
            </motion.h1>
            <motion.p
              className="pf-lede"
              variants={{
                hidden: { opacity: 0, y: 14 },
                show: { opacity: 1, y: 0, transition: { duration: 0.45, ease } },
              }}
            >
              {PROFILE.blurb}
            </motion.p>
            <motion.div
              className="pf-cta-row"
              variants={{
                hidden: { opacity: 0, y: 12 },
                show: { opacity: 1, y: 0, transition: { duration: 0.4, ease } },
              }}
            >
              <button type="button" className="pf-btn pf-btn-primary" onClick={() => scrollToId('work')}>
                See the work
              </button>
              <a
                className="pf-btn"
                href="https://www.linkedin.com/in/futuretonystark"
                target="_blank"
                rel="noreferrer"
              >
                LinkedIn
              </a>
              <a className="pf-btn" href="https://odinwrite.com" target="_blank" rel="noreferrer">
                Odin
              </a>
            </motion.div>
          </motion.div>

          <motion.div
            className="pf-hero-visual"
            initial={{ opacity: 0, scale: 0.96, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.55, ease, delay: 0.08 }}
          >
            <div className="pf-portrait-glow" aria-hidden />
            <div className="pf-portrait-wrap">
              <img
                className="pf-portrait pf-portrait-vale"
                src={portrait}
                alt="Ethan Curtis"
              />
              <div className="pf-portrait-logos" aria-hidden>
                <img className="pf-portrait-logo pf-portrait-logo-cornell" src={cornellLogo} alt="" />
                <img className="pf-portrait-logo pf-portrait-logo-smus" src={smusCrest} alt="" />
              </div>
            </div>
          </motion.div>
        </header>

        <section className="pf-section" id="work">
          <div className="pf-section-head">
            <h2 className="pf-section-title">Work</h2>
            <p className="pf-section-note">Six projects, from first prototype to press coverage.</p>
          </div>
          <div className="pf-stack">
            {PROJECTS.map((p, i) => (
              <ProjectBlock key={p.id} project={p} index={i} />
            ))}
          </div>
        </section>

        <section className="pf-glass pf-contact" id="contact">
          <h2>
            Let&apos;s <em>build</em>.
          </h2>
          <p>
            I&apos;m always glad to talk about products, startups, or competition math. The fastest way
            to reach me is LinkedIn.
          </p>
          <div className="pf-cta-row" style={{ justifyContent: 'center' }}>
            {PROFILE.links.map((l) => (
              <a key={l.href} className="pf-btn" href={l.href} target="_blank" rel="noreferrer">
                {l.label}
              </a>
            ))}
          </div>
        </section>

        <ValedictorianSpeech />

        <footer className="pf-footer">© {new Date().getFullYear()} Ethan Curtis · ethancurtis</footer>
      </div>
    </div>
  )
}
