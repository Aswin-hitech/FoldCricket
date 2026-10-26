import React from 'react'
import styles from './Footer.module.css'

export const Footer: React.FC = () => {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brandRow}>
          <div className={styles.brandCol}>
            <div className={styles.brandLogoLockup}>
              <img src="/logo.jpg" alt="FoldCricket Logo" className={styles.footerLogo} />
              <div>
                <span className={styles.brandName}>FoldCricket</span>
                <p className={styles.brandTagline}>Pick your vintage school memories here.</p>
              </div>
            </div>
            <p className={styles.description}>
              A high-precision, server-authoritative multiplayer simulation honoring the timeless classroom classic. 
              Designed for synchronized real-time matches with seamless innings, animated coin toss, and nostalgic spirit.
            </p>
          </div>

          <div className={styles.authorCol}>
            <h4 className={styles.authorHeading}>Engineering & Development</h4>
            <div className={styles.authorCard}>
              <div className={styles.authorNameRow}>
                <span className={styles.authorName}>Created by Aswin N.</span>
                <span className={styles.authorBadge}>Developer</span>
              </div>
              <div className={styles.contactList}>
                <a
                  href="mailto:kit28.24bam009@gmail.com"
                  className={styles.contactItem}
                  title="Send email"
                >
                  <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                  </svg>
                  <span>kit28.24bam009@gmail.com</span>
                </a>

                <a
                  href="https://www.linkedin.com/in/aswin-n-aiml/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.contactItem}
                  title="Connect on LinkedIn"
                >
                  <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.46 8.76c-.97 0-1.75-.79-1.75-1.76s.78-1.75 1.75-1.75 1.75.78 1.75 1.75-.78 1.76-1.75 1.76m1.4 9.74v-8.37H5.06v8.37h2.8z" />
                  </svg>
                  <span>linkedin.com/in/aswin-n-aiml</span>
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.bottomBar}>
          <span>© {new Date().getFullYear()} FoldCricket. All rights reserved.</span>
          <span className={styles.systemStatus}>Server-Authoritative • WebSocket v2.0 • Ultra-low Latency</span>
        </div>
      </div>
    </footer>
  )
}
