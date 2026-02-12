import { motion } from "framer-motion";
import { Github, Globe, Shield, Zap, Layout, Monitor, ArrowRight, Download } from "lucide-react";

export default function App() {
  return (
    <div className="min-h-screen bg-[#050505] text-white selection:bg-blue-500/30 selection:text-blue-200">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 border-b border-white/5 bg-black/20 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 group cursor-pointer">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-emerald-400 rounded-lg flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
              <Layout className="text-white" size={18} />
            </div>
            <span className="font-bold text-xl tracking-tight">Paste</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="https://github.com" className="text-sm font-medium text-white/60 hover:text-white transition-colors">Source Code</a>
            <a href="https://paste.misonote.com" className="bg-white text-black px-4 py-1.5 rounded-full text-sm font-semibold hover:bg-white/90 transition-all active:scale-95">Open Web App</a>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative pt-32 pb-20 overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[600px] bg-blue-500/10 blur-[120px] rounded-full" />
        
        <div className="max-w-7xl mx-auto px-6 text-center relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <h1 className="text-6xl md:text-8xl font-extrabold tracking-tighter mb-8 bg-clip-text text-transparent bg-gradient-to-b from-white to-white/40">
              The Clipboard,<br />Reimagined.
            </h1>
            <p className="text-xl md:text-2xl text-white/50 max-w-2xl mx-auto mb-12 font-medium leading-relaxed">
              An open-source, high-performance clipboard manager for macOS and Web. Beautiful, private, and free forever.
            </p>
            
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <button className="w-full sm:w-auto px-8 py-4 bg-white text-black rounded-2xl font-bold text-lg flex items-center justify-center gap-2 hover:bg-white/90 transition-all active:scale-95">
                <Download size={20} />
                Download for macOS
              </button>
              <a href="https://github.com" className="w-full sm:w-auto px-8 py-4 bg-white/5 border border-white/10 rounded-2xl font-bold text-lg flex items-center justify-center gap-2 hover:bg-white/10 transition-all active:scale-95">
                <Github size={20} />
                View on GitHub
              </a>
            </div>
          </motion.div>

          {/* App Preview Mockup */}
          <motion.div 
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.8 }}
            className="mt-20 relative max-w-5xl mx-auto"
          >
            <div className="rounded-3xl border border-white/10 bg-white/5 p-2 backdrop-blur-3xl shadow-2xl overflow-hidden">
              <div className="aspect-[16/9] rounded-2xl bg-[#1a1a1a] flex items-end overflow-hidden">
                {/* Simulated Tray */}
                <div className="w-full h-1/3 bg-[#111]/80 border-t border-white/10 p-4 flex gap-4">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="h-full aspect-[1.4/1] bg-white/5 rounded-xl border border-white/10" />
                  ))}
                </div>
              </div>
            </div>
            {/* Glossy decorative element */}
            <div className="absolute -bottom-10 left-1/2 -translate-x-1/2 w-3/4 h-20 bg-blue-500/20 blur-[80px]" />
          </motion.div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-24 relative">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <FeatureCard 
              icon={<Zap className="text-blue-400" />}
              title="Instant Sync"
              description="Your history is available everywhere instantly. Powered by Cloudflare Workers & D1."
            />
            <FeatureCard 
              icon={<Shield className="text-emerald-400" />}
              title="Privacy First"
              description="Fully open-source. Host your own backend or use ours. We never see your data."
            />
            <FeatureCard 
              icon={<Globe className="text-purple-400" />}
              title="Native & Web"
              description="A premium macOS desktop client and a perfectly synchronized web interface."
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-20 border-t border-white/5">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-10">
          <div className="text-white/40 text-sm">
            © 2026 Paste Open Source Project. Built for the community.
          </div>
          <div className="flex gap-8 items-center text-sm font-medium text-white/60">
            <a href="#" className="hover:text-white transition-colors">Documentation</a>
            <a href="#" className="hover:text-white transition-colors">Privacy</a>
            <a href="#" className="hover:text-white transition-colors">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode, title: string, description: string }) {
  return (
    <div className="p-8 rounded-3xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all group">
      <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
        {icon}
      </div>
      <h3 className="text-xl font-bold mb-3">{title}</h3>
      <p className="text-white/40 leading-relaxed">{description}</p>
    </div>
  );
}
