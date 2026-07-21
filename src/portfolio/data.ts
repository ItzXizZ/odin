import odinCompose from './assets/odin-compose.png'
import odinVoice from './assets/odin-voice.png'
import monetaChat from './assets/moneta-chat.png'
import monetaShot from './assets/shot-moneta.png'
import clavDashboard from './assets/clavicular-dashboard.png'
import oscarVideo from './assets/oscarai-vertical.mp4'
import oscarProto1 from './assets/oscar-proto1.jpg'
import oscarProto3 from './assets/oscar-proto3.jpg'
import oscarProto4 from './assets/oscar-proto4.jpg'
import oscarNational from './assets/oscar-national.jpg'
import oscarIngenious from './assets/oscar-ingenious.jpeg'
import oscarVirsf from './assets/oscar-virsf.jpg'
import oscarSmus from './assets/press-oscar-smus.jpg'
import pressBi from './assets/press-business-insider.jpg'
import pressIngenious from './assets/press-ingenious.jpg'
import cgShot from './assets/shot-commongap.png'
import amcPressFull from './assets/press-amc-full.jpg'
import amcPressChek from './assets/press-chek.jpg'
import amcDlMain from './assets/amc-download-main.png'
import amcDl1 from './assets/amc-download-1.png'
import amcDl2 from './assets/amc-download-2.png'

export type GalleryItem = {
  src: string
  alt: string
  caption?: string
  href?: string
  kind: 'photo' | 'press' | 'product'
  outlet?: string
  headline?: string
}

export type MediaLink = {
  label: string
  href: string
  kind: 'live' | 'article' | 'video' | 'award'
}

export type Project = {
  id: string
  name: string
  url?: string
  urlLabel?: string
  tagline: string
  description: string
  bullets: string[]
  media: MediaLink[]
  gallery: GalleryItem[]
  videoEmbed?: string
  videoSrc?: string
  videoAspect?: 'landscape' | 'portrait'
  galleryBelow?: boolean
}

export const PROFILE = {
  name: 'Ethan Curtis',
  handle: 'ethancurtis',
  title: 'Founder · Designer · Engineer',
  location: 'Cornell',
  blurb:
    'I\'m a founder and product designer from Victoria, BC, headed to Cornell this fall. I started a math-competition coaching company that has passed $125K in revenue, and I design and build software products end to end. My work has been covered by Business Insider, BCBusiness, and CHEK News.',
  links: [
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/futuretonystark' },
    { label: 'Odin', href: 'https://odinwrite.com' },
  ],
  valedictorianVideoId: 'S31dEcDFjjk',
}

export const PROJECTS: Project[] = [
  {
    id: 'odin',
    name: 'Odin',
    url: 'https://odinwrite.com',
    urlLabel: 'odinwrite.com',
    tagline: 'A visual canvas for researching and writing with AI',
    description:
      'Odin is a writing studio built around a canvas instead of a chat window. You research with AI as blocks you can branch and rearrange, then move into a focused editor that carries the full context of the board with it.',
    bullets: [
      'About 500 people write in Odin today. The most consistent feedback is that it\'s the best-designed writing tool they\'ve used.',
      'Every AI conversation lives as a block on the canvas, so research builds up visually instead of vanishing into chat history.',
      'The editor writes in your voice, learned from your writing samples and refined every time you correct a draft.',
      'I drafted my own Y Combinator application in it, which remains the most honest product test I\'ve run.',
    ],
    videoEmbed: 'https://www.youtube.com/embed/Vt2RBOLjF2c',
    media: [{ label: 'Open Odin', href: 'https://odinwrite.com', kind: 'live' }],
    gallery: [
      { src: odinCompose, alt: 'Odin compose mode', kind: 'product', caption: 'Compose mode' },
      { src: odinVoice, alt: 'Odin voice graph', kind: 'product', caption: 'Voice graph' },
    ],
  },
  {
    id: 'amc',
    name: 'AMC Academy',
    url: 'https://amcacademy.org',
    urlLabel: 'amcacademy.org',
    tagline: 'Math-competition coaching, founded and run through high school',
    description:
      'AMC Academy coaches students for the AMC and AIME, the exams that open the door to the international math-olympiad pipeline. I founded it in grade ten, after becoming one of Canada\'s top-ranked competitors, and ran it through my senior year.',
    bullets: [
      'Grew it past $125K in revenue, serving more than 100 families across North America.',
      'Recruited and managed coaches from MIT, Berkeley, NYU, and Carnegie Mellon.',
      'Owned everything myself: curriculum, sales, the website and its AI features, marketing, and day-to-day operations.',
      'Profiled by BCBusiness and CHEK News, with a partnership supporting students through STEM Center Africa.',
    ],
    media: [
      { label: 'Open AMC Academy', href: 'https://amcacademy.org', kind: 'live' },
      {
        label: 'BCBusiness',
        href: 'https://bcbusiness.ca/business/education/this-teen-founded-victoria-tutoring-company-is-helping-students-qualify-for-international-math-competitions/',
        kind: 'article',
      },
      {
        label: 'CHEK News',
        href: 'https://cheknews.ca/entrepreneurial-equation-smus-students-operate-profitable-online-tutoring-business-1233661/',
        kind: 'article',
      },
    ],
    gallery: [
      {
        src: amcPressFull,
        alt: 'BCBusiness feature on AMC Academy',
        kind: 'press',
        outlet: 'BCBusiness',
        headline: 'This teen-founded tutoring company is helping students reach international math competitions',
        href: 'https://bcbusiness.ca/business/education/this-teen-founded-victoria-tutoring-company-is-helping-students-qualify-for-international-math-competitions/',
      },
      {
        src: amcPressChek,
        alt: 'CHEK News feature on AMC Academy',
        kind: 'press',
        outlet: 'CHEK News',
        headline: 'SMUS students operate profitable online tutoring business',
        href: 'https://cheknews.ca/entrepreneurial-equation-smus-students-operate-profitable-online-tutoring-business-1233661/',
      },
      {
        src: amcDlMain,
        alt: 'AMC Academy website',
        kind: 'product',
        caption: 'amcacademy.org',
        href: 'https://amcacademy.org',
      },
      { src: amcDl1, alt: 'Student spotlight, Kevin Liu', kind: 'photo', caption: 'Kevin Liu · AIME qualifier' },
      { src: amcDl2, alt: 'Student spotlight, Rohan R.', kind: 'photo', caption: 'Rohan R. · AIME qualifier' },
    ],
  },
  {
    id: 'moneta',
    name: 'Moneta',
    url: 'https://moneta.lol',
    urlLabel: 'moneta.lol',
    tagline: 'AI memory that works the way human memory does',
    description:
      'Moneta stores what an AI knows about you as a graph rather than a table. Memories strengthen when you come back to them, fade when you don\'t, and pull related ideas forward the way real recall does.',
    bullets: [
      'Built first as a therapy companion: every topic a client raises becomes a visible node, and recurring patterns light up on the graph rather than living only in the therapist\'s notes.',
      'Referencing a memory reinforces it and quietly activates its neighbours, so relevant context resurfaces on its own.',
      'This was the first project where I designed before I engineered, and that discipline carried straight into Odin.',
    ],
    videoEmbed: 'https://www.youtube.com/embed/XVW3KR6lqD4',
    media: [{ label: 'Open Moneta', href: 'https://moneta.lol', kind: 'live' }],
    gallery: [
      {
        src: monetaChat,
        alt: 'Moneta memory graph beside a live chat',
        kind: 'product',
        caption: 'The memory graph, live in a conversation',
      },
      {
        src: monetaShot,
        alt: 'Moneta landing page',
        kind: 'product',
        caption: 'moneta.lol',
        href: 'https://moneta.lol',
      },
    ],
  },
  {
    id: 'clavicular',
    name: 'Clavicular',
    url: 'https://clavicular.ai',
    urlLabel: 'clavicular.ai',
    tagline: 'An AI face-rating app with a public leaderboard',
    description:
      'Clavicular began as a joke among friends: upload a photo, get an honest AI rating, and land on a public leaderboard. It turned into a real product, and a small lesson in what people actually share, which is standing rather than utility.',
    bullets: [
      'Reached 500 users with zero ad spend, entirely through word of mouth.',
      'The paid tier was designed, built, and launched in a single day, and it now covers the app\'s roughly $150 in monthly costs.',
    ],
    media: [{ label: 'Open Clavicular', href: 'https://clavicular.ai', kind: 'live' }],
    gallery: [
      {
        src: clavDashboard,
        alt: 'Clavicular analysis dashboard',
        kind: 'product',
        caption: 'The analysis dashboard',
        href: 'https://clavicular.ai',
      },
    ],
  },
  {
    id: 'oscarai',
    name: 'OscarAI',
    url: 'https://oscarai.ca',
    urlLabel: 'oscarai.ca',
    tagline: 'A robot bin that sees and sorts waste',
    description:
      'OscarAI is a bin that sorts its own recycling. A camera identifies each item and motors route it into the right compartment. It started as a cardboard science-fair project and went through four hardware revisions on its way to national recognition.',
    bullets: [
      'Placed second at the Vancouver Island Regional Science Fair and won the BC Game Developers Innovation Award.',
      'Recognized nationally with an Ingenious+ innovation award and a place at the Canada-Wide Science Fair.',
      'Now operates as a small company, with ten product-engineering interns and customers internationally.',
    ],
    videoSrc: oscarVideo,
    videoAspect: 'portrait',
    media: [
      { label: 'Open OscarAI', href: 'https://oscarai.ca', kind: 'live' },
      {
        label: 'SMUS News',
        href: 'https://www.smus.ca/news/oscar-ai-triumphs-regionals-nationals',
        kind: 'article',
      },
      {
        label: 'Ingenious+',
        href: 'https://ingeniousplus.ca/29-ingenious-youth-recognized-for-outstanding-innovation-in-b-c-and-y-t/',
        kind: 'award',
      },
    ],
    gallery: [
      {
        src: oscarSmus,
        alt: 'SMUS News feature on OscarAI',
        kind: 'press',
        outlet: 'SMUS News',
        headline: 'Oscar AI triumphs: from regionals to nationals',
        href: 'https://www.smus.ca/news/oscar-ai-triumphs-regionals-nationals',
      },
      {
        src: pressIngenious,
        alt: 'Ingenious+ award announcement',
        kind: 'press',
        outlet: 'Ingenious+',
        headline: '29 ingenious youth recognized for outstanding innovation',
        href: 'https://ingeniousplus.ca/29-ingenious-youth-recognized-for-outstanding-innovation-in-b-c-and-y-t/',
      },
      { src: oscarProto1, alt: 'First OscarAI prototype', kind: 'photo', caption: 'First prototype' },
      { src: oscarProto3, alt: 'Third OscarAI prototype', kind: 'photo', caption: 'Third prototype' },
      { src: oscarProto4, alt: 'Fourth OscarAI prototype', kind: 'photo', caption: 'Fourth prototype' },
      { src: oscarVirsf, alt: 'OscarAI at the regional science fair', kind: 'photo', caption: 'Regional science fair' },
      { src: oscarIngenious, alt: 'Ingenious+ award ceremony', kind: 'photo', caption: 'Ingenious+ Awards' },
      { src: oscarNational, alt: 'OscarAI at the Canada-Wide Science Fair', kind: 'photo', caption: 'Canada-Wide Science Fair' },
    ],
  },
  {
    id: 'commongap',
    name: 'Common Gap',
    url: 'https://www.commongap.com/',
    urlLabel: 'commongap.com',
    tagline: 'Paid gap years at Y Combinator startups',
    description:
      'Common Gap, built with Oliver Zou at Deep24 (YC S24), matches high-school graduates into paid roles at Y Combinator startups as an alternative to a traditional gap year. There is no resume upload. The application asks one question: what is the most impressive thing you have ever built?',
    bullets: [
      'Every placement pays at least $75K, and most offers have landed above $100K.',
      'More than 1,000 high schoolers have applied since launch.',
      'I designed the product and wrote most of the code. Business Insider covered the launch.',
    ],
    media: [
      { label: 'Open Common Gap', href: 'https://www.commongap.com/', kind: 'live' },
      {
        label: 'Business Insider',
        href: 'https://www.businessinsider.com/what-if-your-gap-year-paid-six-figures-2026-1',
        kind: 'article',
      },
    ],
    galleryBelow: true,
    gallery: [
      {
        src: pressBi,
        alt: 'Business Insider feature on Common Gap',
        kind: 'press',
        outlet: 'Business Insider',
        headline: 'What if your gap year paid six figures?',
        href: 'https://www.businessinsider.com/what-if-your-gap-year-paid-six-figures-2026-1',
      },
      {
        src: cgShot,
        alt: 'Common Gap website',
        kind: 'product',
        caption: 'commongap.com',
        href: 'https://www.commongap.com/',
      },
    ],
  },
]
