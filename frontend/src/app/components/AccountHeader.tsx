import { Link } from 'react-router-dom'
import { ThemeToggle } from '../../context/ThemeContext'
import { AccountMenu } from './AccountMenu'
import styles from './AccountHeader.module.css'

export function AccountHeader() {
  return (
    <header className={styles.bar}>
      <Link to="/" className={styles.brand}>
        <img src="/logo.jpg" alt="" className={styles.logo} />
        <span className={styles.brandName}>FoldCricket</span>
      </Link>
      <div className={styles.actions}>
        <Link to="/" className={styles.playLink}>
          ← Play
        </Link>
        <ThemeToggle />
        <AccountMenu />
      </div>
    </header>
  )
}
