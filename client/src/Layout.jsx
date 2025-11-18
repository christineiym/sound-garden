import LeftDrawer from './Drawer'

export default function Layout({ children, links = [] }) {
    return (
        <div className="min-h-screen w-full text-white relative">
            <LeftDrawer links={links} />
            {children}
        </div>
    );
}